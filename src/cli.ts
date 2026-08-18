#!/usr/bin/env node
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readlineCore from 'node:readline';
import * as readline from 'node:readline/promises';
import { exec, execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CLAUDE_LIFECYCLE_HOOK_EVENTS,
  CLAUDE_MANAGED_HOOK_MARKER,
  extractClaudeModelFromHookInput,
  extractClaudeSessionId,
  getManagedClaudeHookStatus,
  installManagedClaudeHooks,
  readClaudeModelFromTranscript,
  removeManagedClaudeHooks
} from './claude-hooks';
import {
  ClaudeQuotaEngine,
  claudeCredentialGeneration,
  createClaudeCredentialStore,
  createFetchClaudeHttpClient,
  evaluateClaudeQuotaEligibility
} from './claude-quota';
import {
  detectedClaudeForSetup,
  detectedCodexForSetup,
  shouldInstallClaudeHooks,
  shouldInstallCodexHooks
} from './commands/setup/policy';
import { detectSetupTools } from './adapters/system/installed-tools';
import { runMetaCommand } from './commands/meta/command';
import { getArgString, parseArgs } from './commands/args';
import {
  DEFAULT_CLAUDE_CLIENT_ID,
  DEFAULT_CODEX_CLIENT_ID,
  DEFAULT_OPENCODE_CLIENT_ID,
  DEFAULT_PI_CLIENT_ID,
  requireToolPresence,
  toolProviders
} from './providers/registry';
import {
  pc,
  APP_ID,
  APP_TITLE,
  APP_AUTHOR,
  APP_WEBSITE,
  APP_REPOSITORY,
  APP_LICENSE,
  MACOS_LAUNCH_AGENT_ID,
  WINDOWS_TASK_NAME,
  PI_EXTENSION_TARGET,
  OPENCODE_PLUGIN_TARGET,
  USER_DATA_DIR,
  CONFIG_DIR,
  CONFIG_FILE,
  LEGACY_CONFIG_FILE,
  DEFAULT_STATE_FILE,
  STATE_FILE,
  CONFIG_EDITOR_FIELDS,
  CODEX_HOME,
  CODEX_HOOKS_FILE,
  CLAUDE_CONFIG_DIR,
  CLAUDE_SETTINGS_FILE,
  CLAUDE_CREDENTIALS_FILE,
  CLAUDE_KEYCHAIN_SERVICE,
  CODEX_HOOK_EVENTS,
  CODEX_CLIENT_ID,
  CLAUDE_CLIENT_ID,
  OPENCODE_CLIENT_ID,
  PI_CLIENT_ID,
  DETAIL_LEVEL,
  USAGE_TEXT,
  USAGE_COMMAND,
  CODEX_QUOTA_SOURCE,
  CODEX_BIN,
  CODEX_AUTH_FILE,
  CODEX_API_BASE_URL,
  CODEX_OAUTH_CLIENT_ID,
  LIMITS_TEXT_OVERRIDE,
  ACTIVITY_STYLE,
  STATE_MAX_AGE_MS,
  STATE_LOCK_TIMEOUT_MS,
  DEBUG_ENABLED,
  USAGE_TIMEOUT_MS,
  USAGE_REFRESH_INTERVAL_MS,
  MAX_PRESENCE_TEXT_LENGTH,
  VERSION,
  dim,
  success,
  warning,
  danger,
  accent,
  title,
  execFileSyncString,
  compactHomePath,
  shellQuoteArg,
  asRecord,
  extractString,
  extractNumber,
  extractNumberLike,
  getPackageRoot,
  logError
} from './env';
import {
  isTerminalStatus,
  joinPresenceParts,
  joinMetricParts,
  sanitizeProjectName,
  sanitizePackageName,
  formatContextText,
  titleCase
} from './presence-text';
import type {
  ActivityStyle,
  ConfigEditorField,
  ConfigPreviewSamples,
  ConfigTuiItem,
  ConfigTuiResult,
  DetailLevel,
  DisplayLayout
} from './commands/config/types';
import {
  BOOLEAN_CONFIG_KEYS,
  CONFIG_TUI_ITEMS,
  DEFAULT_ACTIVITY_STYLE,
  DEFAULT_CODEX_AUTH_FILE,
  DEFAULT_CODEX_QUOTA_SOURCE,
  DEFAULT_DETAIL_LEVEL,
  ENV_CONFIG_ALIASES
} from './commands/config/schema';
import {
  defaultDisplayLayout,
  displayLayoutFromEntries,
  envValue,
  normalizeActivityStyle,
  normalizeCodexQuotaSource,
  normalizeDetailLevel,
  parseDotEnv,
  parseOptionalBoolean,
  readJsonConfigFile
} from './commands/config/settings';
import type { SetupToolDetection } from './core/detection/types';
import type { HookSessionState } from './core/hooks/types';
import {
  cleanupStateSessions,
  clearHookState,
  claudeHookSessionFromArgs,
  claudeQuotaRequestOptions,
  codexHookSessionFromArgs,
  debugLog,
  readClaudeSettings,
  readStateFile,
  sessionFromArgs,
  upsertHookState
} from './state-store';
import type {
  CodexOAuthCredentials,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotSource,
  CodexQuotaSource,
  CodexQuotaWindow,
  PendingJsonRpcRequest
} from './core/quota/types';
import type { DaemonRefreshResult } from './adapters/startup/types';
import {
  claudeQuotaEngine,
  getNativeCodexQuotaText
} from './quota';
import {
  getGitBranch,
  readPackageInfo
} from './presence';
import { startDaemon } from './daemon';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function getInstallDirectory(): string {
  return path.join(CONFIG_DIR, 'app');
}

function getLogDirectory(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', APP_ID);
  }

  return path.join(CONFIG_DIR, 'logs');
}

function getRuntimeScriptPath(baseDirectory = getPackageRoot()): string {
  return path.join(baseDirectory, 'dist', 'cli.js');
}

function detectionFamilyName(key: string): string {
  if (key.startsWith('codex')) {
    return 'Codex';
  }
  if (key.startsWith('claude')) {
    return 'Claude';
  }
  if (key.startsWith('opencode')) {
    return 'OpenCode';
  }
  if (key.startsWith('pi')) {
    return 'Pi';
  }
  return titleCase(key);
}

function printSessionIntegrations(): void {
  const rows: Array<{ name: string; installed: boolean; target: string }> = [
    {
      name: 'Pi extension',
      installed: fs.existsSync(PI_EXTENSION_TARGET),
      target: PI_EXTENSION_TARGET
    },
    {
      name: 'OpenCode plugin',
      installed: fs.existsSync(OPENCODE_PLUGIN_TARGET),
      target: OPENCODE_PLUGIN_TARGET
    }
  ];

  console.log('');
  console.log(title('Session integrations'));
  for (const row of rows) {
    const marker = row.installed ? success('✔') : dim('✖');
    const hint = row.installed
      ? accent(compactHomePath(row.target))
      : dim('not installed — copy the bundled file to this path to enable');
    console.log(`  ${marker} ${row.name.padEnd(16)} ${hint}`);
  }
}

function printSetupDetections(detections: SetupToolDetection[]): void {
  const families = new Map<string, SetupToolDetection[]>();
  for (const item of detections) {
    const family = detectionFamilyName(item.key);
    const items = families.get(family) || [];
    items.push(item);
    families.set(family, items);
  }

  const maxNameLength = Math.max(...detections.map((item) => item.name.length));
  const detectedCount = detections.filter((item) => item.detected).length;

  console.log('');
  console.log(title('Detected tools'));
  for (const [family, items] of families) {
    console.log(`  ${pc.bold(family)}`);
    for (const item of items) {
      const marker = item.detected ? success('✔') : dim('✖');
      const name = item.name.padEnd(maxNameLength);
      const detail = item.detected
        ? accent(item.detail || 'installed')
        : dim('not installed');
      console.log(`    ${marker} ${name}  ${detail}`);
    }
  }
  console.log(dim(`  ${detectedCount} of ${detections.length} tool installations found.`));
}

function copyPathIfExists(source: string, target: string): void {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (entry: string) => {
      const basename = path.basename(entry);
      return !['.git', '.DS_Store', 'coverage', 'states.json', 'states.json.lock'].includes(basename);
    }
  });
}

function readRuntimeDependencyNames(packageRoot: string): string[] {
  const packageFile = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies || {}).sort();
}

function missingRuntimeDependencies(runtimeRoot: string, dependencies: string[]): string[] {
  return dependencies.filter((dependency) => !fs.existsSync(
    path.join(runtimeRoot, 'node_modules', dependency, 'package.json')
  ));
}

function installRuntimeDependencies(runtimeRoot: string): void {
  const npmArgs = [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--loglevel=error'
  ];
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  const useNpmExecPath = Boolean(npmExecPath && fs.existsSync(npmExecPath));
  const command = useNpmExecPath
    ? process.execPath
    : (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm');
  const args = useNpmExecPath
    ? [npmExecPath, ...npmArgs]
    : (process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...npmArgs] : npmArgs);

  try {
    execFileSync(command, args, {
      cwd: runtimeRoot,
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: Buffer | string }).stderr || '').trim()
      : '';
    throw new Error(`Failed to install runtime dependencies${stderr ? `: ${stderr}` : '.'}`);
  }
}

function copyRuntimeToInstallDir(): string {
  const packageRoot = getPackageRoot();
  const builtScript = getRuntimeScriptPath(packageRoot);
  if (!fs.existsSync(builtScript)) {
    throw new Error('Missing dist build. Run `npm run build` before setup when working from source.');
  }

  const installDir = getInstallDirectory();
  const tempDir = `${installDir}.tmp-${process.pid}`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    copyPathIfExists(path.join(packageRoot, 'dist'), path.join(tempDir, 'dist'));
    copyPathIfExists(path.join(packageRoot, 'node_modules'), path.join(tempDir, 'node_modules'));
    copyPathIfExists(path.join(packageRoot, 'package.json'), path.join(tempDir, 'package.json'));
    copyPathIfExists(path.join(packageRoot, 'README.md'), path.join(tempDir, 'README.md'));
    copyPathIfExists(path.join(packageRoot, 'LICENSE'), path.join(tempDir, 'LICENSE'));

    const runtimeDependencies = readRuntimeDependencyNames(tempDir);
    let missingDependencies = missingRuntimeDependencies(tempDir, runtimeDependencies);
    if (missingDependencies.length > 0) {
      installRuntimeDependencies(tempDir);
      missingDependencies = missingRuntimeDependencies(tempDir, runtimeDependencies);
    }
    if (missingDependencies.length > 0) {
      throw new Error(`Missing runtime dependencies: ${missingDependencies.join(', ')}`);
    }

    fs.rmSync(installDir, { recursive: true, force: true });
    fs.renameSync(tempDir, installDir);
    return getRuntimeScriptPath(installDir);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function readSetupConfigEntries(): Record<string, string> {
  const legacy = fs.existsSync(LEGACY_CONFIG_FILE)
    ? parseDotEnv(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8'))
    : {};

  return {
    ...legacy,
    ...readJsonConfigFile(CONFIG_FILE, logError)
  };
}

function serializeJsonConfig(entries: Record<string, string>): string {
  const filtered = Object.fromEntries(
    Object.entries(entries)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => {
        const booleanValue = BOOLEAN_CONFIG_KEYS.has(key) ? parseOptionalBoolean(value) : null;
        return [ENV_CONFIG_ALIASES[key] || key, booleanValue ?? value];
      })
  );

  return `${JSON.stringify(filtered, null, 2)}\n`;
}

function setConfigIfCustom(
  config: Record<string, string>,
  key: string,
  value: string | null | undefined,
  defaultValue = ''
): void {
  const normalized = String(value || '').trim();
  if (normalized && normalized !== defaultValue) {
    config[key] = normalized;
  }
}

function setConfigIfPresent(config: Record<string, string>, existing: Record<string, string>, key: string): void {
  const value = String(existing[key] || '').trim();
  if (value) {
    config[key] = value;
  }
}

function setConfigBooleanIfCustom(
  config: Record<string, string>,
  entries: Record<string, string>,
  key: string,
  defaultValue: boolean
): void {
  const value = parseOptionalBoolean(entries[key]);
  if (value !== null && value !== defaultValue) {
    config[key] = String(value);
  }
}

function compactConfigEntries(entries: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  const fallbackClientId = String(entries.DISCORD_CLIENT_ID || '').trim();
  const detailLevel = normalizeDetailLevel(
    entries.DISCORD_CODING_STATUS_DETAIL_LEVEL || DEFAULT_DETAIL_LEVEL
  );
  const displayDefaults = defaultDisplayLayout(detailLevel);

  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_CODEX_CLIENT_ID',
    entries.DISCORD_CODING_STATUS_CODEX_CLIENT_ID || DEFAULT_CODEX_CLIENT_ID,
    DEFAULT_CODEX_CLIENT_ID
  );
  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID',
    entries.DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID || DEFAULT_CLAUDE_CLIENT_ID,
    DEFAULT_CLAUDE_CLIENT_ID
  );
  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_OPENCODE_CLIENT_ID',
    entries.DISCORD_CODING_STATUS_OPENCODE_CLIENT_ID || DEFAULT_OPENCODE_CLIENT_ID,
    DEFAULT_OPENCODE_CLIENT_ID
  );
  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_PI_CLIENT_ID',
    entries.DISCORD_CODING_STATUS_PI_CLIENT_ID || DEFAULT_PI_CLIENT_ID,
    DEFAULT_PI_CLIENT_ID
  );
  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_DETAIL_LEVEL',
    detailLevel,
    DEFAULT_DETAIL_LEVEL
  );
  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE',
    normalizeCodexQuotaSource(entries.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE || DEFAULT_CODEX_QUOTA_SOURCE),
    DEFAULT_CODEX_QUOTA_SOURCE
  );
  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_ACTIVITY_STYLE',
    normalizeActivityStyle(entries.DISCORD_CODING_STATUS_ACTIVITY_STYLE || DEFAULT_ACTIVITY_STYLE),
    DEFAULT_ACTIVITY_STYLE
  );
  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_STATE_FILE',
    entries.DISCORD_CODING_STATUS_STATE_FILE || DEFAULT_STATE_FILE,
    DEFAULT_STATE_FILE
  );
  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_CODEX_AUTH_FILE',
    entries.DISCORD_CODING_STATUS_CODEX_AUTH_FILE || DEFAULT_CODEX_AUTH_FILE,
    DEFAULT_CODEX_AUTH_FILE
  );

  if (fallbackClientId !== DEFAULT_CODEX_CLIENT_ID && fallbackClientId !== DEFAULT_CLAUDE_CLIENT_ID) {
    setConfigIfCustom(next, 'DISCORD_CLIENT_ID', fallbackClientId);
  }

  for (const key of [
    'DISCORD_CODING_STATUS_CLAUDE_IMAGE_KEY',
    'DISCORD_CODING_STATUS_CODEX_IMAGE_KEY',
    'DISCORD_CODING_STATUS_OPENCODE_IMAGE_KEY',
    'DISCORD_CODING_STATUS_PI_IMAGE_KEY',
    'DISCORD_LARGE_IMAGE_KEY',
    'DISCORD_SMALL_IMAGE_KEY',
    'DISCORD_CODING_STATUS_PLAN_TEXT',
    'DISCORD_CODING_STATUS_LIMITS_TEXT'
  ]) {
    setConfigIfPresent(next, entries, key);
  }

  setConfigIfCustom(
    next,
    'DISCORD_CODING_STATUS_PREFER_CODEX_CLI',
    entries.DISCORD_CODING_STATUS_PREFER_CODEX_CLI,
    'false'
  );

  setConfigBooleanIfCustom(
    next,
    entries,
    'DISCORD_CODING_STATUS_SHOW_ACTIVITY',
    displayDefaults.activity
  );
  setConfigBooleanIfCustom(
    next,
    entries,
    'DISCORD_CODING_STATUS_SHOW_PROJECT',
    displayDefaults.project
  );
  setConfigBooleanIfCustom(
    next,
    entries,
    'DISCORD_CODING_STATUS_SHOW_MODEL',
    displayDefaults.model
  );
  setConfigBooleanIfCustom(
    next,
    entries,
    'DISCORD_CODING_STATUS_SHOW_QUOTA',
    displayDefaults.quota
  );
  setConfigBooleanIfCustom(
    next,
    entries,
    'DISCORD_CODING_STATUS_SHOW_CONTEXT',
    displayDefaults.context
  );
  setConfigBooleanIfCustom(
    next,
    entries,
    'DISCORD_CODING_STATUS_SHOW_PACKAGE',
    displayDefaults.package
  );

  return next;
}

function writeSetupConfig(args: Record<string, string | boolean>): void {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const existing = readSetupConfigEntries();
  const fallbackClientId = getArgString(args, 'client-id')
    || getArgString(args, 'client_id')
    || existing.DISCORD_CLIENT_ID
    || '';
  const codexClientId = getArgString(args, 'codex-client-id')
    || getArgString(args, 'codex_client_id')
    || CODEX_CLIENT_ID;
  const claudeClientId = getArgString(args, 'claude-client-id')
    || getArgString(args, 'claude_client_id')
    || CLAUDE_CLIENT_ID;
  const opencodeClientId = getArgString(args, 'opencode-client-id')
    || getArgString(args, 'opencode_client_id')
    || OPENCODE_CLIENT_ID;
  const piClientId = getArgString(args, 'pi-client-id')
    || getArgString(args, 'pi_client_id')
    || PI_CLIENT_ID;
  const detailLevel = getArgString(args, 'detail-level')
    || getArgString(args, 'detail_level')
    || existing.DISCORD_CODING_STATUS_DETAIL_LEVEL
    || DETAIL_LEVEL;
  const quotaSource = getArgString(args, 'codex-quota-source')
    || getArgString(args, 'codex_quota_source')
    || existing.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE
    || CODEX_QUOTA_SOURCE;
  const next = compactConfigEntries({
    ...existing,
    DISCORD_CLIENT_ID: fallbackClientId,
    DISCORD_CODING_STATUS_CODEX_CLIENT_ID: codexClientId,
    DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID: claudeClientId,
    DISCORD_CODING_STATUS_OPENCODE_CLIENT_ID: opencodeClientId,
    DISCORD_CODING_STATUS_PI_CLIENT_ID: piClientId,
    DISCORD_CODING_STATUS_DETAIL_LEVEL: detailLevel,
    DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE: quotaSource
  });

  fs.writeFileSync(CONFIG_FILE, serializeJsonConfig(next));
}

function formatConfigValue(value: string): string {
  return value ? accent(value) : dim('(empty)');
}

function configFieldHelp(field: ConfigEditorField): string {
  return field.choices ? dim(` choices: ${field.choices.join('/')}`) : '';
}

async function promptConfigField(
  rl: import('node:readline/promises').Interface,
  field: ConfigEditorField,
  currentOverride: string
): Promise<string> {
  const effectiveValue = currentOverride || field.defaultValue;
  const currentText = effectiveValue || '(empty)';

  while (true) {
    const answer = (await rl.question(
      `${field.label}${configFieldHelp(field)} ${dim(`[${currentText}]`)}: `
    )).trim();

    if (!answer) {
      return currentOverride;
    }

    if (answer === '-') {
      return '';
    }

    if (field.choices && !field.choices.includes(answer)) {
      console.log(warning(`Invalid value. Use one of: ${field.choices.join(', ')}`));
      continue;
    }

    return answer;
  }
}

function printEffectiveConfig(entries: Record<string, string>): void {
  console.log(title('Discord Coding Status advanced config'));
  console.log(`${pc.bold('File:')} ${accent(CONFIG_FILE)}`);
  console.log(dim('Enter keeps the current/default value. Use "-" to clear an override.'));
  console.log('');

  for (const field of CONFIG_EDITOR_FIELDS) {
    const override = entries[field.key] || '';
    const effective = override || field.defaultValue;
    const suffix = override ? '' : dim(' (default)');
    console.log(`  ${pc.bold(field.label)}: ${formatConfigValue(effective)}${suffix}`);
  }

  console.log('');
}

function applyDisplayLayout(entries: Record<string, string>, layout: DisplayLayout): void {
  entries.DISCORD_CODING_STATUS_SHOW_ACTIVITY = String(layout.activity);
  entries.DISCORD_CODING_STATUS_SHOW_PROJECT = String(layout.project);
  entries.DISCORD_CODING_STATUS_SHOW_MODEL = String(layout.model);
  entries.DISCORD_CODING_STATUS_SHOW_QUOTA = String(layout.quota);
  entries.DISCORD_CODING_STATUS_SHOW_CONTEXT = String(layout.context);
  entries.DISCORD_CODING_STATUS_SHOW_PACKAGE = String(layout.package);
}

function initializeConfigTuiEntries(existing: Record<string, string>): Record<string, string> {
  const next = { ...existing };
  const detailLevel = normalizeDetailLevel(
    existing.DISCORD_CODING_STATUS_DETAIL_LEVEL || DEFAULT_DETAIL_LEVEL
  );

  next.DISCORD_CODING_STATUS_DETAIL_LEVEL = detailLevel;
  next.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE = normalizeCodexQuotaSource(
    existing.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE || DEFAULT_CODEX_QUOTA_SOURCE
  );
  next.DISCORD_CODING_STATUS_ACTIVITY_STYLE = normalizeActivityStyle(
    existing.DISCORD_CODING_STATUS_ACTIVITY_STYLE || DEFAULT_ACTIVITY_STYLE
  );
  next.DISCORD_CODING_STATUS_PREFER_CODEX_CLI = String(
    parseOptionalBoolean(existing.DISCORD_CODING_STATUS_PREFER_CODEX_CLI) ?? false
  );
  applyDisplayLayout(next, displayLayoutFromEntries(existing));
  return next;
}

function latestConfigPreviewSession(): HookSessionState | null {
  const sessions = Object.values(readStateFile().sessions)
    .filter((session) => !isTerminalStatus(session.status))
    .sort((left, right) => right.updated_at - left.updated_at);
  return sessions[0] || null;
}

function createConfigPreviewSamples(): ConfigPreviewSamples {
  const session = latestConfigPreviewSession();
  const cwd = session?.cwd || process.cwd();
  const packageInfo = readPackageInfo(cwd);
  const projectName = sanitizeProjectName(session?.project)
    || sanitizeProjectName(packageInfo?.root)
    || sanitizeProjectName(cwd)
    || 'my-project';
  const branchName = getGitBranch(packageInfo?.root || cwd) || 'main';
  const model = String(session?.model || 'gpt-5.6-sol').trim();
  const effort = String(session?.effort || 'xhigh').trim();

  return {
    activity: 'Bash survived the assignment',
    project: `${projectName} @ ${branchName}`,
    model: effort ? `${model} · ${effort}` : model,
    quota: 'Pro • 5h 82% • weekly 54%',
    context: formatContextText(session?.context) || 'ctx 42%',
    package: `pkg ${sanitizePackageName(session?.package) || packageInfo?.name || 'my-package'}`
  };
}

function activityStylePreview(style: ActivityStyle, fallback: string): string {
  if (style === 'normal') {
    return 'Running a command';
  }

  if (style === 'technical') {
    return 'Running Bash';
  }

  if (style === 'minimal') {
    return 'Working';
  }

  return fallback;
}

function configPreviewLines(
  entries: Record<string, string>,
  samples: ConfigPreviewSamples
): { top: string; bottom: string } {
  const layout = displayLayoutFromEntries(entries);
  const activityStyle = normalizeActivityStyle(
    entries.DISCORD_CODING_STATUS_ACTIVITY_STYLE || DEFAULT_ACTIVITY_STYLE
  );
  const quotaSource = normalizeCodexQuotaSource(
    entries.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE || DEFAULT_CODEX_QUOTA_SOURCE
  );
  const planOverride = String(entries.DISCORD_CODING_STATUS_PLAN_TEXT || '').trim();
  const limitsOverride = String(entries.DISCORD_CODING_STATUS_LIMITS_TEXT || '').trim();
  const quota = planOverride || limitsOverride
    ? joinMetricParts([planOverride || 'Pro', limitsOverride || '5h 82% • weekly 54%'])
    : (quotaSource === 'off' ? 'Codex quota disabled' : samples.quota);

  return {
    top: joinPresenceParts([
      layout.activity ? activityStylePreview(activityStyle, samples.activity) : null,
      layout.project ? samples.project : null
    ]),
    bottom: joinPresenceParts([
      layout.model ? samples.model : null,
      layout.quota ? quota : null,
      layout.context ? samples.context : null,
      layout.package ? samples.package : null
    ])
  };
}

function tuiChoiceValue(item: ConfigTuiItem, entries: Record<string, string>): string {
  const choices = item.choices || [];
  const value = String(entries[item.key] || '').trim();
  return choices.includes(value) ? value : (choices[0] || value);
}

function truncateTerminalText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return maxLength > 3 ? `${value.slice(0, maxLength - 3)}...` : value.slice(0, maxLength);
}

function renderConfigTui(
  entries: Record<string, string>,
  samples: ConfigPreviewSamples,
  selectedIndex: number,
  notice: string
): string {
  const preview = configPreviewLines(entries, samples);
  const terminalWidth = Math.max(48, process.stdout.columns || 100);
  const previewWidth = Math.max(24, terminalWidth - 11);
  const lines = [
    title(`${APP_TITLE} · Display Config`),
    dim(`File: ${truncateTerminalText(compactHomePath(CONFIG_FILE), terminalWidth - 6)}`),
    '',
    pc.bold('LIVE PREVIEW') + dim('  sample data · Discord uses up to 128 characters per line'),
    `  ${dim('Top   ')} ${preview.top ? truncateTerminalText(preview.top, previewWidth) : dim('(hidden)')}`,
    `  ${dim('Bottom')} ${preview.bottom ? truncateTerminalText(preview.bottom, previewWidth) : dim('(hidden)')}`,
    ''
  ];
  let currentSection: ConfigTuiItem['section'] | null = null;

  CONFIG_TUI_ITEMS.forEach((item, index) => {
    if (item.section !== currentSection) {
      currentSection = item.section;
      lines.push(pc.bold(item.section.toUpperCase()));
    }

    const selected = index === selectedIndex;
    const pointer = selected ? accent('›') : ' ';
    let control: string;
    let controlLength: number;

    if (item.kind === 'toggle') {
      const enabled = parseOptionalBoolean(entries[item.key]) ?? false;
      control = enabled ? success('[x]') : dim('[ ]');
      controlLength = 3;
    } else {
      const value = tuiChoiceValue(item, entries);
      control = `${dim('‹')} ${accent(value)} ${dim('›')}`;
      controlLength = value.length + 4;
    }

    const label = selected ? pc.bold(item.label) : item.label;
    lines.push(` ${pointer} ${control}${' '.repeat(Math.max(1, 18 - controlLength))} ${label}`);
  });

  lines.push(
    '',
    notice ? warning(notice) : dim('Changes are written only when you save.'),
    dim('↑/↓ move  ·  Space/Enter toggle  ·  ←/→ change'),
    dim('R preset  ·  A advanced  ·  S save  ·  Q cancel')
  );

  return `\x1b[2J\x1b[H${lines.join('\n')}`;
}

function cycleConfigTuiChoice(
  entries: Record<string, string>,
  item: ConfigTuiItem,
  direction: number
): string {
  const choices = item.choices || [];
  if (!choices.length) {
    return '';
  }

  const current = tuiChoiceValue(item, entries);
  const currentIndex = Math.max(0, choices.indexOf(current));
  const nextIndex = (currentIndex + direction + choices.length) % choices.length;
  const value = choices[nextIndex];
  entries[item.key] = value;

  if (item.key === 'DISCORD_CODING_STATUS_DETAIL_LEVEL') {
    applyDisplayLayout(entries, defaultDisplayLayout(normalizeDetailLevel(value)));
    return `Applied the ${value} display preset.`;
  }

  return '';
}

async function runConfigTui(existing: Record<string, string>): Promise<ConfigTuiResult> {
  const entries = initializeConfigTuiEntries(existing);
  const samples = createConfigPreviewSamples();
  const input = process.stdin;
  const output = process.stdout;
  const previousRawMode = Boolean(input.isRaw);
  let selectedIndex = 0;
  let notice = '';

  readlineCore.emitKeypressEvents(input);

  return new Promise((resolve) => {
    let finished = false;

    const render = () => {
      output.write(renderConfigTui(entries, samples, selectedIndex, notice));
    };
    const finish = (action: ConfigTuiResult['action']) => {
      if (finished) {
        return;
      }
      finished = true;
      input.removeListener('keypress', onKeypress);
      output.removeListener('resize', render);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(previousRawMode);
      }
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      resolve({ action, entries });
    };
    const activateSelected = () => {
      const item = CONFIG_TUI_ITEMS[selectedIndex];
      if (item.kind === 'toggle') {
        const enabled = parseOptionalBoolean(entries[item.key]) ?? false;
        entries[item.key] = String(!enabled);
        notice = `${item.label} ${enabled ? 'hidden' : 'shown'}.`;
      } else {
        notice = cycleConfigTuiChoice(entries, item, 1);
      }
      render();
    };
    const onKeypress = (_character: string, key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
      const name = key?.name || '';

      if ((key?.ctrl && name === 'c') || name === 'escape' || name === 'q') {
        finish('cancel');
        return;
      }
      if (name === 's') {
        finish('save');
        return;
      }
      if (name === 'a') {
        finish('advanced');
        return;
      }
      if (name === 'up' || name === 'k') {
        selectedIndex = (selectedIndex - 1 + CONFIG_TUI_ITEMS.length) % CONFIG_TUI_ITEMS.length;
        notice = '';
        render();
        return;
      }
      if (name === 'down' || name === 'j') {
        selectedIndex = (selectedIndex + 1) % CONFIG_TUI_ITEMS.length;
        notice = '';
        render();
        return;
      }
      if (name === 'left' || name === 'right') {
        const item = CONFIG_TUI_ITEMS[selectedIndex];
        if (item.kind === 'choice') {
          notice = cycleConfigTuiChoice(entries, item, name === 'left' ? -1 : 1);
          render();
        }
        return;
      }
      if (name === 'r') {
        const detailLevel = normalizeDetailLevel(
          entries.DISCORD_CODING_STATUS_DETAIL_LEVEL || DEFAULT_DETAIL_LEVEL
        );
        applyDisplayLayout(entries, defaultDisplayLayout(detailLevel));
        notice = `Restored the ${detailLevel} display preset.`;
        render();
        return;
      }
      if (name === 'space' || name === 'return') {
        activateSelected();
      }
    };

    input.on('keypress', onKeypress);
    output.on('resize', render);
    if (typeof input.setRawMode === 'function') {
      input.setRawMode(true);
    }
    input.resume();
    output.write('\x1b[?1049h\x1b[?25l');
    render();
  });
}

async function runAdvancedConfigEditor(existing: Record<string, string>): Promise<Record<string, string>> {
  printEffectiveConfig(existing);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const next = { ...existing };

  try {
    for (const field of CONFIG_EDITOR_FIELDS) {
      const value = await promptConfigField(rl, field, next[field.key] || '');
      if (value) {
        next[field.key] = value;
      } else {
        delete next[field.key];
      }
    }
  } finally {
    rl.close();
  }

  return next;
}

function getMacLaunchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MACOS_LAUNCH_AGENT_ID}.plist`);
}

function restartManagedDaemon(skipRestart = false): DaemonRefreshResult {
  if (skipRestart) {
    return { status: 'skipped' };
  }

  if (process.platform === 'darwin') {
    const plistPath = getMacLaunchAgentPath();
    if (!fs.existsSync(plistPath)) {
      return { status: 'not-installed' };
    }

    const domain = `gui/${process.getuid ? process.getuid() : ''}`;
    const serviceTarget = `${domain}/${MACOS_LAUNCH_AGENT_ID}`;
    try {
      execFileSync('launchctl', ['kickstart', '-k', serviceTarget], { stdio: 'ignore' });
      return { status: 'restarted' };
    } catch (_) {
      try {
        execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore' });
        execFileSync('launchctl', ['kickstart', '-k', serviceTarget], { stdio: 'ignore' });
        return { status: 'restarted' };
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore' });
    } catch (_) {
      return { status: 'not-installed' };
    }

    try {
      try {
        execFileSync('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore' });
      } catch (_) {
        // The task may already be stopped.
      }
      execFileSync('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore' });
      return { status: 'restarted' };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return { status: 'unsupported' };
}

function printDaemonRefreshResult(result: DaemonRefreshResult): void {
  if (result.status === 'restarted') {
    console.log(success('Daemon restarted. Config is now active.'));
    return;
  }

  if (result.status === 'skipped') {
    console.log(dim('Daemon restart skipped by --no-restart.'));
    return;
  }

  if (result.status === 'failed') {
    console.log(warning('Config was saved, but the managed daemon could not be restarted. Restart it manually.'));
    debugLog(`Managed daemon restart failed: ${result.error || 'unknown error'}`);
    return;
  }

  if (result.status === 'not-installed') {
    console.log(dim('No managed daemon installation was found. Restart a manually running daemon to apply changes.'));
    return;
  }

  console.log(dim('Automatic daemon restart is unavailable on this platform. Restart the daemon manually.'));
}

function writeConfigEntries(
  entries: Record<string, string>,
  options: { action?: 'save' | 'reset'; skipRestart?: boolean } = {}
): void {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, serializeJsonConfig(compactConfigEntries(entries)));
  const verb = options.action === 'reset' ? 'Reset' : 'Saved';
  console.log(success(`${verb} config: ${CONFIG_FILE}`));
  printDaemonRefreshResult(restartManagedDaemon(Boolean(options.skipRestart)));
}

async function runConfigCommand(command: string): Promise<boolean> {
  if (!['config', 'configure'].includes(command)) {
    return false;
  }

  const args = parseArgs(process.argv.slice(3));
  const existing = readSetupConfigEntries();
  const skipRestart = Boolean(args['no-restart'] || args.no_restart);

  if (args.reset) {
    writeConfigEntries({}, { action: 'reset', skipRestart });
    return true;
  }

  if (args.show || args.json) {
    console.log(serializeJsonConfig(compactConfigEntries(existing)).trim());
    return true;
  }

  if (args.preview) {
    const preview = configPreviewLines(existing, createConfigPreviewSamples());
    console.log(title(`${APP_TITLE} preview`));
    console.log(`${pc.bold('Top:')} ${preview.top || dim('(hidden)')}`);
    console.log(`${pc.bold('Bottom:')} ${preview.bottom || dim('(hidden)')}`);
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(danger('Config editor requires an interactive terminal. Use `config --show`, `config --preview`, or `config --reset` in scripts.'));
    process.exitCode = 1;
    return true;
  }

  if (args.advanced || args.prompts) {
    writeConfigEntries(await runAdvancedConfigEditor(existing), { skipRestart });
    return true;
  }

  const result = await runConfigTui(existing);
  if (result.action === 'cancel') {
    console.log(dim('Config unchanged.'));
    return true;
  }

  if (result.action === 'advanced') {
    writeConfigEntries(await runAdvancedConfigEditor(result.entries), { skipRestart });
    return true;
  }

  writeConfigEntries(result.entries, { skipRestart });
  return true;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function installMacLaunchAgent(scriptPath: string, startNow: boolean): string {
  const plistPath = getMacLaunchAgentPath();
  const launchAgentsDir = path.dirname(plistPath);
  const logDir = getLogDirectory();
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(MACOS_LAUNCH_AGENT_ID)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(path.dirname(scriptPath))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'discord-coding-status.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'discord-coding-status.error.log'))}</string>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plist);

  if (startNow) {
    const domain = `gui/${process.getuid ? process.getuid() : ''}`;
    try {
      execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    } catch (_) {
      // The service may not be loaded yet.
    }

    try {
      execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore' });
    } catch (_) {
      execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
    }
  }

  return plistPath;
}

function writeWindowsLauncher(scriptPath: string): string {
  const installDir = getInstallDirectory();
  const logDir = getLogDirectory();
  const launcherPath = path.join(installDir, `${APP_ID}.cmd`);
  fs.mkdirSync(logDir, { recursive: true });

  const content = [
    '@echo off',
    `cd /d "${path.dirname(scriptPath)}"`,
    `"${process.execPath}" "${scriptPath}" daemon >> "${path.join(logDir, 'discord-coding-status.log')}" 2>> "${path.join(logDir, 'discord-coding-status.error.log')}"`
  ].join('\r\n') + '\r\n';

  fs.writeFileSync(launcherPath, content);
  return launcherPath;
}

function windowsScheduledTaskArgs(launcherPath: string): string[] {
  return [
    '/Create',
    '/TN',
    WINDOWS_TASK_NAME,
    '/SC',
    'ONLOGON',
    '/TR',
    `"${launcherPath}"`,
    '/F'
  ];
}

function execFileStderr(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const stderr = (error as { stderr?: Buffer | string }).stderr;
  return String(stderr || '').trim();
}

function installWindowsScheduledTask(scriptPath: string, startNow: boolean): string {
  const launcherPath = writeWindowsLauncher(scriptPath);
  const args = windowsScheduledTaskArgs(launcherPath);

  try {
    execFileSync('schtasks', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const detail = execFileStderr(error);

    try {
      // The current session lacks permission to create a logon task; retry
      // elevated through UAC so the user can approve the prompt.
      const argumentList = args.map((arg) => (arg.startsWith('"') ? arg : `"${arg}"`)).join(' ');
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Start-Process -FilePath schtasks -ArgumentList '${argumentList}' -Verb RunAs -Wait`
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (elevationError) {
      const elevationDetail = execFileStderr(elevationError);
      throw new Error(
        `Failed to create the scheduled task (${detail || 'Access is denied'}. `
        + `Run setup from an Administrator terminal, or accept the UAC prompt.`
        + `${elevationDetail ? ` Elevated attempt failed: ${elevationDetail}` : ''})`
      );
    }
  }

  if (startNow) {
    try {
      execFileSync('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_) {
      // The task is installed even if immediate start fails.
    }
  }

  return WINDOWS_TASK_NAME;
}

function installStartup(scriptPath: string, startNow: boolean): string {
  if (process.platform === 'darwin') {
    return installMacLaunchAgent(scriptPath, startNow);
  }

  if (process.platform === 'win32') {
    return installWindowsScheduledTask(scriptPath, startNow);
  }

  throw new Error('Setup currently supports macOS and Windows.');
}

function uninstallStartup(purge: boolean): void {
  if (process.platform === 'darwin') {
    const plistPath = getMacLaunchAgentPath();
    const domain = `gui/${process.getuid ? process.getuid() : ''}`;
    try {
      execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    } catch (_) {
      // It may already be unloaded.
    }
    fs.rmSync(plistPath, { force: true });
  } else if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'], { stdio: 'ignore' });
    } catch (_) {
      // It may already be deleted.
    }
  } else {
    throw new Error('Uninstall currently supports macOS and Windows.');
  }

  fs.rmSync(getInstallDirectory(), { recursive: true, force: true });
  if (purge) {
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  }
}

function printStartupStatus(): void {
  if (process.platform === 'darwin') {
    const plistPath = getMacLaunchAgentPath();
    console.log(JSON.stringify({
      platform: 'macos',
      installed: fs.existsSync(plistPath),
      plistPath,
      configFile: CONFIG_FILE,
      stateFile: STATE_FILE,
      codexClientId: CODEX_CLIENT_ID,
      claudeClientId: CLAUDE_CLIENT_ID,
      opencodeClientId: OPENCODE_CLIENT_ID,
      piClientId: PI_CLIENT_ID,
      installDirectory: getInstallDirectory()
    }, null, 2));
    return;
  }

  if (process.platform === 'win32') {
    let installed = false;
    try {
      execFileSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore' });
      installed = true;
    } catch (_) {
      installed = false;
    }

    console.log(JSON.stringify({
      platform: 'windows',
      installed,
      taskName: WINDOWS_TASK_NAME,
      configFile: CONFIG_FILE,
      stateFile: STATE_FILE,
      codexClientId: CODEX_CLIENT_ID,
      claudeClientId: CLAUDE_CLIENT_ID,
      opencodeClientId: OPENCODE_CLIENT_ID,
      piClientId: PI_CLIENT_ID,
      installDirectory: getInstallDirectory()
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    platform: process.platform,
    installed: false,
    supported: false
  }, null, 2));
}

function codexHookCommand(scriptPath: string, event: string): string {
  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'codex-hook',
    '--event',
    event
  ].join(' ');
}

function readCodexHooksConfig(): Record<string, unknown> {
  if (!fs.existsSync(CODEX_HOOKS_FILE)) {
    return { hooks: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(CODEX_HOOKS_FILE, 'utf8')) as unknown;
  return asRecord(parsed) || { hooks: {} };
}

function writeCodexHooksConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CODEX_HOOKS_FILE), { recursive: true });

  if (fs.existsSync(CODEX_HOOKS_FILE)) {
    fs.copyFileSync(CODEX_HOOKS_FILE, `${CODEX_HOOKS_FILE}.bak`);
  }

  fs.writeFileSync(CODEX_HOOKS_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

function isDiscordCodingStatusHook(hook: unknown): boolean {
  const record = asRecord(hook);
  if (!record) {
    return false;
  }

  const statusMessage = extractString(record.statusMessage);
  const command = extractString(record.command);

  return (
    statusMessage === APP_TITLE ||
    Boolean(command && command.includes(APP_ID) && command.includes('codex-hook'))
  );
}

function removeDiscordCodingStatusHooks(config: Record<string, unknown>): number {
  const hooks = asRecord(config.hooks) || {};
  config.hooks = hooks;
  let removed = 0;

  for (const [eventName, groupsValue] of Object.entries(hooks)) {
    if (!Array.isArray(groupsValue)) {
      continue;
    }

    const nextGroups = groupsValue
      .map((groupValue) => {
        const group = asRecord(groupValue);
        if (!group) {
          return groupValue;
        }

        const hookList = Array.isArray(group.hooks) ? group.hooks : [];
        const nextHookList = hookList.filter((hook) => {
          const shouldRemove = isDiscordCodingStatusHook(hook);
          if (shouldRemove) {
            removed += 1;
          }

          return !shouldRemove;
        });

        return {
          ...group,
          hooks: nextHookList
        };
      })
      .filter((groupValue) => {
        const group = asRecord(groupValue);
        return !group || !Array.isArray(group.hooks) || group.hooks.length > 0;
      });

    if (nextGroups.length) {
      hooks[eventName] = nextGroups;
    } else {
      delete hooks[eventName];
    }
  }

  return removed;
}

function installCodexHooks(scriptPath: string): { hooksFile: string; installed: number; removed: number } {
  const config = readCodexHooksConfig();
  const hooks = asRecord(config.hooks) || {};
  config.hooks = hooks;
  const removed = removeDiscordCodingStatusHooks(config);
  let installed = 0;

  for (const eventName of CODEX_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] as Array<unknown> : [];
    groups.push({
      hooks: [
        {
          type: 'command',
          command: codexHookCommand(scriptPath, eventName),
          statusMessage: APP_TITLE
        }
      ]
    });
    hooks[eventName] = groups;
    installed += 1;
  }

  writeCodexHooksConfig(config);
  return {
    hooksFile: CODEX_HOOKS_FILE,
    installed,
    removed
  };
}

function uninstallCodexHooks(): { hooksFile: string; removed: number } {
  const config = readCodexHooksConfig();
  const removed = removeDiscordCodingStatusHooks(config);

  if (removed > 0) {
    writeCodexHooksConfig(config);
  }

  return {
    hooksFile: CODEX_HOOKS_FILE,
    removed
  };
}

function printCodexHooksStatus(): void {
  let installed = 0;
  if (fs.existsSync(CODEX_HOOKS_FILE)) {
    const config = readCodexHooksConfig();
    const hooks = asRecord(config.hooks) || {};
    for (const groupsValue of Object.values(hooks)) {
      if (!Array.isArray(groupsValue)) {
        continue;
      }

      for (const groupValue of groupsValue) {
        const group = asRecord(groupValue);
        const hookList = Array.isArray(group?.hooks) ? group.hooks : [];
        installed += hookList.filter(isDiscordCodingStatusHook).length;
      }
    }
  }

  console.log(JSON.stringify({
    codexHome: CODEX_HOME,
    hooksFile: CODEX_HOOKS_FILE,
    hooksFileExists: fs.existsSync(CODEX_HOOKS_FILE),
    installed,
    expectedEvents: CODEX_HOOK_EVENTS
  }, null, 2));
}

function claudeHookCommand(scriptPath: string, event: string): string {
  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'claude-hook',
    '--event',
    event,
    CLAUDE_MANAGED_HOOK_MARKER
  ].join(' ');
}


function writeClaudeSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_FILE), { recursive: true });

  if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    fs.copyFileSync(CLAUDE_SETTINGS_FILE, `${CLAUDE_SETTINGS_FILE}.bak`);
  }

  const tempFile = `${CLAUDE_SETTINGS_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, CLAUDE_SETTINGS_FILE);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {
      // The successful rename already removed the temporary pathname.
    }
  }
}

function installClaudeHooks(scriptPath: string): { settingsFile: string; installed: number; removed: number } {
  const result = installManagedClaudeHooks(readClaudeSettings(), {
    events: CLAUDE_LIFECYCLE_HOOK_EVENTS,
    commandForEvent: (eventName) => claudeHookCommand(scriptPath, eventName),
    timeout: 5
  });
  writeClaudeSettings(result.settings);
  return {
    settingsFile: CLAUDE_SETTINGS_FILE,
    installed: result.installed,
    removed: result.removed
  };
}

function uninstallClaudeHooks(): { settingsFile: string; removed: number } {
  const result = removeManagedClaudeHooks(readClaudeSettings());
  if (result.removed > 0) {
    writeClaudeSettings(result.settings);
  }

  return {
    settingsFile: CLAUDE_SETTINGS_FILE,
    removed: result.removed
  };
}

function printClaudeHooksStatus(): void {
  const settings = readClaudeSettings();
  const status = getManagedClaudeHookStatus(settings, CLAUDE_LIFECYCLE_HOOK_EVENTS);
  console.log(JSON.stringify({
    claudeConfigDir: CLAUDE_CONFIG_DIR,
    settingsFile: CLAUDE_SETTINGS_FILE,
    settingsFileExists: fs.existsSync(CLAUDE_SETTINGS_FILE),
    expectedEvents: CLAUDE_LIFECYCLE_HOOK_EVENTS,
    ...status
  }, null, 2));
}

function runStateCommand(command: string): boolean {
  if (!['hook', 'codex-hook', 'claude-hook', 'clear', 'state'].includes(command)) {
    return false;
  }

  const args = parseArgs(process.argv.slice(3));

  if (command === 'state') {
    console.log(JSON.stringify(cleanupStateSessions(readStateFile(), Date.now()), null, 2));
    return true;
  }

  if (command === 'clear') {
    const sessionId = getArgString(args, 'session-id') || getArgString(args, 'session_id');
    if (!sessionId) {
      console.error(danger('Missing --session-id.'));
      process.exitCode = 1;
      return true;
    }

    clearHookState(sessionId);
    console.log(success(`Cleared session ${sessionId}`));
    return true;
  }

  if (command === 'codex-hook') {
    const session = codexHookSessionFromArgs(args);
    upsertHookState(session);
    return true;
  }

  if (command === 'claude-hook') {
    const session = claudeHookSessionFromArgs(args);
    upsertHookState(session);
    return true;
  }

  const session = sessionFromArgs(args);
  if (!session) {
    console.error(danger('Missing valid hook state. Required: --tool <name>. Recommended: --session-id <id> --cwd "$PWD".'));
    process.exitCode = 1;
    return true;
  }

  upsertHookState(session);
  console.log(JSON.stringify({ ok: true, stateFile: STATE_FILE, session }, null, 2));
  return true;
}

function runSetupCommand(command: string): boolean {
  if (!['setup', 'install', 'uninstall', 'status', 'startup-status'].includes(command)) {
    return false;
  }

  const args = parseArgs(process.argv.slice(3));
  const detections = detectSetupTools({
    executableOverrides: { codexCli: [CODEX_BIN] },
    pathOverrides: { codexHome: CODEX_HOME }
  }, toolProviders);

  if (command === 'status' || command === 'startup-status') {
    printStartupStatus();
    return true;
  }

  if (command === 'uninstall') {
    uninstallStartup(Boolean(args.purge));
    console.log(success(`${APP_TITLE} startup entry removed.`));
    return true;
  }

  const dryRun = Boolean(args['dry-run'] || args.dry_run);
  const startNow = !Boolean(args['no-start'] || args.no_start);
  const installCodexHookSet = shouldInstallCodexHooks(args, detections, toolProviders);
  const installClaudeHookSet = shouldInstallClaudeHooks(args, detections, toolProviders);

  if (dryRun) {
    console.log(JSON.stringify({
      platform: process.platform,
      configFile: CONFIG_FILE,
      stateFile: STATE_FILE,
      installDirectory: getInstallDirectory(),
      codexClientId: CODEX_CLIENT_ID,
      claudeClientId: CLAUDE_CLIENT_ID,
      opencodeClientId: OPENCODE_CLIENT_ID,
      piClientId: PI_CLIENT_ID,
      detectedTools: detections,
      codexHooks: {
        install: installCodexHookSet,
        mode: (args['codex-hooks'] || args.codex_hooks)
          ? 'forced'
          : ((args['no-codex-hooks'] || args.no_codex_hooks) ? 'disabled' : 'auto')
      },
      claudeHooks: {
        install: installClaudeHookSet,
        mode: (args['claude-hooks'] || args.claude_hooks)
          ? 'forced'
          : ((args['no-claude-hooks'] || args.no_claude_hooks) ? 'disabled' : 'auto')
      },
      startup: process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'LaunchAgents', `${MACOS_LAUNCH_AGENT_ID}.plist`)
        : WINDOWS_TASK_NAME
    }, null, 2));
    return true;
  }

  writeSetupConfig(args);
  const scriptPath = copyRuntimeToInstallDir();
  const startupTarget = installStartup(scriptPath, startNow);
  const codexHooks = installCodexHookSet
    ? installCodexHooks(scriptPath)
    : null;
  const claudeHooks = installClaudeHookSet
    ? installClaudeHooks(scriptPath)
    : null;

  console.log('');
  console.log(success(`${APP_TITLE} installed.`));
  printSetupDetections(detections);

  console.log('');
  console.log(title('Installation'));
  console.log(`  ${pc.bold('Config').padEnd(10)} ${accent(compactHomePath(CONFIG_FILE))}`);
  console.log(`  ${pc.bold('Runtime').padEnd(10)} ${accent(scriptPath)}`);
  console.log(`  ${pc.bold('Startup').padEnd(10)} ${accent(startupTarget)}`);

  const hookLines: string[] = [];
  if (codexHooks) {
    hookLines.push(`  ${success(`✔ ${codexHooks.installed} Codex hooks`)} → ${accent(codexHooks.hooksFile)}`);
    hookLines.push(dim('    Open Codex and run `/hooks` once to review and trust the new hooks.'));
  } else if (detectedCodexForSetup(detections, toolProviders)) {
    hookLines.push(warning('  ✖ Codex hooks skipped by --no-codex-hooks.'));
  } else {
    hookLines.push(dim('  · Codex hooks skipped (Codex not detected).'));
  }
  if (claudeHooks) {
    hookLines.push(`  ${success(`✔ ${claudeHooks.installed} Claude hooks`)} → ${accent(claudeHooks.settingsFile)}`);
  } else if (detectedClaudeForSetup(detections, toolProviders)) {
    hookLines.push(warning('  ✖ Claude hooks skipped by --no-claude-hooks.'));
  } else {
    hookLines.push(dim('  · Claude hooks skipped (Claude Code not detected).'));
  }
  if (hookLines.length) {
    console.log('');
    console.log(title('Managed hooks'));
    for (const line of hookLines) {
      console.log(line);
    }
  }
  printSessionIntegrations();
  if (!startNow) {
    console.log(dim('Startup is installed; the daemon will run at next login.'));
  }

  return true;
}

function runCodexHooksCommand(command: string): boolean {
  if (!['setup-codex-hooks', 'install-codex-hooks', 'uninstall-codex-hooks', 'codex-hooks-status'].includes(command)) {
    return false;
  }

  if (command === 'codex-hooks-status') {
    printCodexHooksStatus();
    return true;
  }

  if (command === 'uninstall-codex-hooks') {
    const result = uninstallCodexHooks();
    console.log(`${success(`Removed ${result.removed}`)} ${APP_TITLE} Codex hook(s) from ${accent(result.hooksFile)}.`);
    return true;
  }

  const scriptPath = copyRuntimeToInstallDir();
  const result = installCodexHooks(scriptPath);
  console.log(`${success(`Installed ${result.installed}`)} ${APP_TITLE} Codex hook(s) in ${accent(result.hooksFile)}.`);
  if (result.removed) {
    console.log(warning(`Replaced ${result.removed} existing ${APP_TITLE} hook(s).`));
  }
  console.log(warning('Open Codex and run `/hooks` once to review and trust the new hooks.'));
  return true;
}

function runClaudeHooksCommand(command: string): boolean {
  if (![
    'setup-claude-hooks',
    'install-claude-hooks',
    'enable-claude-hooks',
    'disable-claude-hooks',
    'uninstall-claude-hooks',
    'claude-hooks-status'
  ].includes(command)) {
    return false;
  }

  if (command === 'claude-hooks-status') {
    printClaudeHooksStatus();
    return true;
  }

  if (command === 'disable-claude-hooks' || command === 'uninstall-claude-hooks') {
    const result = uninstallClaudeHooks();
    console.log(`${success(`Removed ${result.removed}`)} ${APP_TITLE} Claude hook(s) from ${accent(result.settingsFile)}.`);
    return true;
  }

  const scriptPath = copyRuntimeToInstallDir();
  const result = installClaudeHooks(scriptPath);
  console.log(`${success(`Installed ${result.installed}`)} ${APP_TITLE} Claude hook(s) in ${accent(result.settingsFile)}.`);
  if (result.removed) {
    console.log(warning(`Replaced ${result.removed} existing ${APP_TITLE} Claude hook(s).`));
  }
  return true;
}

async function runQuotaCommand(command: string): Promise<boolean> {
  if (!['quota', 'codex-quota'].includes(command)) {
    return false;
  }

  const args = parseArgs(process.argv.slice(3));
  const requestedTool = command === 'quota'
    ? (getArgString(args, 'tool') || 'codex').trim().toLowerCase()
    : 'codex';

  if (requestedTool === 'claude' || requestedTool === 'claude-code') {
    const result = await claudeQuotaEngine.getQuota(claudeQuotaRequestOptions());
    if (result.status === 'unavailable') {
      console.error(danger(result.diagnostic));
      process.exitCode = 1;
      return true;
    }

    console.log(result.quota.text);
    return true;
  }

  if (requestedTool !== 'codex') {
    console.error(danger(`Unsupported quota tool: ${requestedTool}. Use codex or claude.`));
    process.exitCode = 1;
    return true;
  }

  const source = normalizeCodexQuotaSource(getArgString(args, 'source') || CODEX_QUOTA_SOURCE);
  const quotaText = await getNativeCodexQuotaText({ ...requireToolPresence('codexCli') }, source);

  if (!quotaText) {
    console.error(danger('Codex quota unavailable. Try --source oauth, --source rpc, or DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE=auto.'));
    process.exitCode = 1;
    return true;
  }

  console.log(quotaText);
  return true;
}



const command = process.argv[2] || '';

async function main(): Promise<void> {
  if (runMetaCommand(command, {
    appTitle: APP_TITLE,
    version: VERSION,
    author: APP_AUTHOR,
    website: APP_WEBSITE,
    repository: APP_REPOSITORY,
    license: APP_LICENSE,
    codexClientId: CODEX_CLIENT_ID,
    claudeClientId: CLAUDE_CLIENT_ID,
    opencodeClientId: OPENCODE_CLIENT_ID,
    piClientId: PI_CLIENT_ID,
    configFile: CONFIG_FILE,
    stateFile: STATE_FILE
  })) {
    process.exit(process.exitCode || 0);
  }

  if (await runConfigCommand(command)) {
    process.exit(process.exitCode || 0);
  }

  if (runSetupCommand(command)) {
    process.exit(process.exitCode || 0);
  }

  if (runCodexHooksCommand(command)) {
    process.exit(process.exitCode || 0);
  }

  if (runClaudeHooksCommand(command)) {
    process.exit(process.exitCode || 0);
  }

  if (runStateCommand(command)) {
    process.exit(process.exitCode || 0);
  }

  if (await runQuotaCommand(command)) {
    process.exit(process.exitCode || 0);
  }

  if (command && command !== 'daemon') {
    console.error(danger(`Unknown command: ${command}`));
    console.error(dim('Run `discord-coding-status --help` for usage.'));
    process.exit(1);
  }

  startDaemon();
}

main().catch((error) => {
  logError('Startup failed', error);
  process.exit(process.exitCode || 1);
});
