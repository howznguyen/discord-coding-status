#!/usr/bin/env node
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CLAUDE_LIFECYCLE_HOOK_EVENTS,
  CLAUDE_MANAGED_HOOK_MARKER,
  getManagedClaudeHookStatus,
  installManagedClaudeHooks,
  removeManagedClaudeHooks
} from './claude-hooks';
import {
  GROK_HOOK_EVENTS,
  GROK_HOOKS_DIR,
  GROK_HOOKS_FILE,
  getManagedGrokHookStatus,
  grokHookSessionFromArgs,
  installManagedGrokHooks,
  removeManagedGrokHooks
} from './grok-hooks';
import {
  ClaudeQuotaEngine,
  claudeCredentialGeneration,
  createClaudeCredentialStore,
  createFetchClaudeHttpClient,
  evaluateClaudeQuotaEligibility
} from './claude-quota';
import { renderStatusSummary, sessionToActivityItem } from './commands/status/summary';
import { detectSetupTools } from './adapters/system/installed-tools';
import { runMetaCommand } from './commands/meta/command';
import { runConfigCommand } from './commands/config/command';
import { runConfigTui, configPreviewLines } from './commands/config/tui';
import { runAdvancedConfigEditor } from './commands/config/editor';
import {
  BOOLEAN_CONFIG_KEYS,
  DEFAULT_ACTIVITY_STYLE,
  DEFAULT_CODEX_AUTH_FILE,
  DEFAULT_CODEX_QUOTA_SOURCE,
  DEFAULT_DETAIL_LEVEL,
  ENV_CONFIG_ALIASES
} from './commands/config/schema';
import {
  defaultDisplayLayout,
  displayLayoutFromEntries,
  normalizeActivityStyle,
  normalizeCodexQuotaSource,
  normalizeDetailLevel,
  parseDotEnv,
  parseOptionalBoolean,
  readJsonConfigFile
} from './commands/config/settings';
import { runSetupCommand } from './commands/setup/command';
import { buildSetupToolRows } from './commands/setup/tools';
import { runHooksCommand } from './commands/hooks/command';
import { runStateCommand } from './commands/state/command';
import { runQuotaCommand } from './commands/quota/command';
import {
  getMacLaunchAgentPath,
  installMacLaunchAgent,
  installWindowsScheduledTask,
  restartManagedDaemon
} from './adapters/startup/service';
import type { DaemonRefreshResult } from './adapters/startup/types';
import type { ConfigPreviewSamples } from './commands/config/types';
import type { HookSessionState } from './core/hooks/types';
import { parseArgs, getArgString } from './commands/args';
import {
  DEFAULT_CLAUDE_CLIENT_ID,
  DEFAULT_CODEX_CLIENT_ID,
  DEFAULT_OPENCODE_CLIENT_ID,
  DEFAULT_PI_CLIENT_ID,
  DEFAULT_GROK_CLIENT_ID,
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
  CODEX_HOOK_EVENTS,
  CODEX_CLIENT_ID,
  CLAUDE_CLIENT_ID,
  OPENCODE_CLIENT_ID,
  PI_CLIENT_ID,
  GROK_CLIENT_ID,
  CURSOR_CLIENT_ID,
  DETAIL_LEVEL,
  CODEX_QUOTA_SOURCE,
  CODEX_BIN,
  VERSION,
  dim,
  success,
  warning,
  danger,
  accent,
  title,
  compactHomePath,
  shellQuoteArg,
  asRecord,
  getPackageRoot,
  logError
} from './env';
import {
  isTerminalStatus,
  joinPresenceParts,
  joinMetricParts,
  sanitizeProjectName,
  sanitizePackageName,
  formatContextText
} from './presence-text';
import {
  cleanupStateSessions,
  clearHookState,
  claudeHookSessionFromArgs,
  claudeQuotaRequestOptions,
  codexHookSessionFromArgs,
  debugLog,
  isGrokProcessAncestry,
  readClaudeSettings,
  readStateFile,
  sessionFromArgs,
  upsertHookState
} from './state-store';
import {
  claudeQuotaEngine,
  fetchAllHarnessQuotas,
  getNativeCodexQuotaText,
  getNativeCursorQuotaText,
  getNativeGrokQuotaText,
  getNativeOpencodeQuotaText
} from './quota';
import { getGitBranch, readPackageInfo } from './presence';
import { startDaemon } from './daemon';

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

function stopRunningDaemonForUpdate(): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore' });
    } catch (_) {}

    try {
      const installDirPattern = getInstallDirectory().replace(/\\/g, '\\\\');
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like "*discord-coding-status*daemon*" -or $_.CommandLine -like "*${installDirPattern}*") -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
      ], { stdio: 'ignore' });
    } catch (_) {
      try {
        execFileSync('taskkill', ['/F', '/FI', 'WINDOWTITLE eq discord-coding-status*'], { stdio: 'ignore' });
      } catch (_) {}
    }
  } else if (process.platform === 'darwin') {
    try {
      const plistPath = getMacLaunchAgentPath(MACOS_LAUNCH_AGENT_ID);
      const domain = `gui/${process.getuid ? process.getuid() : ''}`;
      execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    } catch (_) {}
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait for short durations
  }
}

function removeDirectoryWithRetry(target: string, maxAttempts = 5): void {
  if (!fs.existsSync(target)) {
    return;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        try {
          const trashDir = `${target}.old-${Date.now()}`;
          fs.renameSync(target, trashDir);
          try {
            fs.rmSync(trashDir, { recursive: true, force: true });
          } catch (_) {}
          return;
        } catch (_) {
          throw error;
        }
      }
      sleepSync(100 * attempt);
    }
  }
}

function replaceDirectorySafe(sourceTemp: string, destination: string): void {
  removeDirectoryWithRetry(destination);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.renameSync(sourceTemp, destination);
      return;
    } catch (error) {
      if (attempt === 5) {
        fs.cpSync(sourceTemp, destination, { recursive: true, force: true });
        fs.rmSync(sourceTemp, { recursive: true, force: true });
        return;
      }
      sleepSync(100 * attempt);
    }
  }
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
  return dependencies.filter((name) => !fs.existsSync(path.join(runtimeRoot, 'node_modules', name, 'package.json')));
}

function installRuntimeDependencies(runtimeRoot: string): void {
  const npmExecPath = process.env.npm_execpath;
  const useNpmExecPath = Boolean(npmExecPath && fs.existsSync(npmExecPath));
  const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  const command = useNpmExecPath
    ? process.execPath
    : (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm');
  const args = useNpmExecPath
    ? [npmExecPath!, ...npmArgs]
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

  stopRunningDaemonForUpdate();

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

    replaceDirectorySafe(tempDir, installDir);
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
    'DISCORD_CODING_STATUS_GROK_CLIENT_ID',
    entries.DISCORD_CODING_STATUS_GROK_CLIENT_ID || DEFAULT_GROK_CLIENT_ID,
    DEFAULT_GROK_CLIENT_ID
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

  setConfigBooleanIfCustom(next, entries, 'DISCORD_CODING_STATUS_SHOW_ACTIVITY', displayDefaults.activity);
  setConfigBooleanIfCustom(next, entries, 'DISCORD_CODING_STATUS_SHOW_PROJECT', displayDefaults.project);
  setConfigBooleanIfCustom(next, entries, 'DISCORD_CODING_STATUS_SHOW_MODEL', displayDefaults.model);
  setConfigBooleanIfCustom(next, entries, 'DISCORD_CODING_STATUS_SHOW_QUOTA', displayDefaults.quota);
  setConfigBooleanIfCustom(next, entries, 'DISCORD_CODING_STATUS_SHOW_CONTEXT', displayDefaults.context);
  setConfigBooleanIfCustom(next, entries, 'DISCORD_CODING_STATUS_SHOW_PACKAGE', displayDefaults.package);

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
  const grokClientId = getArgString(args, 'grok-client-id')
    || getArgString(args, 'grok_client_id')
    || GROK_CLIENT_ID;
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
    DISCORD_CODING_STATUS_GROK_CLIENT_ID: grokClientId,
    DISCORD_CODING_STATUS_DETAIL_LEVEL: detailLevel,
    DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE: quotaSource
  });

  fs.writeFileSync(CONFIG_FILE, serializeJsonConfig(next));
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
  const refreshResult = restartManagedDaemon({
    macosLaunchAgentId: MACOS_LAUNCH_AGENT_ID,
    windowsTaskName: WINDOWS_TASK_NAME,
    skipRestart: options.skipRestart
  });
  printDaemonRefreshResult(refreshResult);
}

function installStartup(scriptPath: string, startNow: boolean): string {
  if (process.platform === 'darwin') {
    return installMacLaunchAgent(scriptPath, startNow, {
      launchAgentId: MACOS_LAUNCH_AGENT_ID,
      logDirectory: getLogDirectory()
    });
  }

  if (process.platform === 'win32') {
    return installWindowsScheduledTask(scriptPath, startNow, {
      taskName: WINDOWS_TASK_NAME,
      installDirectory: getInstallDirectory(),
      logDirectory: getLogDirectory(),
      appId: APP_ID
    });
  }

  throw new Error('Setup currently supports macOS and Windows.');
}

function uninstallStartup(purge: boolean): void {
  if (process.platform === 'darwin') {
    const plistPath = getMacLaunchAgentPath(MACOS_LAUNCH_AGENT_ID);
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

async function printStartupStatus(args: Record<string, string | boolean> = {}): Promise<void> {
  const isJson = Boolean(args.json || args['json']);

  let installed = false;
  let target = '';

  if (process.platform === 'darwin') {
    const plistPath = getMacLaunchAgentPath(MACOS_LAUNCH_AGENT_ID);
    installed = fs.existsSync(plistPath);
    target = plistPath;
  } else if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore' });
      installed = true;
    } catch (_) {
      installed = false;
    }
    target = WINDOWS_TASK_NAME;
  }

  if (isJson) {
    console.log(JSON.stringify({
      platform: process.platform === 'darwin' ? 'macos' : (process.platform === 'win32' ? 'windows' : process.platform),
      installed,
      target,
      configFile: CONFIG_FILE,
      stateFile: STATE_FILE,
      codexClientId: CODEX_CLIENT_ID,
      claudeClientId: CLAUDE_CLIENT_ID,
      opencodeClientId: OPENCODE_CLIENT_ID,
      piClientId: PI_CLIENT_ID,
      grokClientId: GROK_CLIENT_ID,
      installDirectory: getInstallDirectory()
    }, null, 2));
    return;
  }

  const detections = detectSetupTools({
    executableOverrides: { codexCli: [CODEX_BIN] },
    pathOverrides: { codexHome: CODEX_HOME }
  }, toolProviders);

  const claudeHooksStatus = getManagedClaudeHookStatus(readClaudeSettings(), CLAUDE_LIFECYCLE_HOOK_EVENTS);
  const grokHooksStatus = getManagedGrokHookStatus();
  const codexInstalled = fs.existsSync(CODEX_HOOKS_FILE);

  const tools = buildSetupToolRows({
    detections,
    providers: toolProviders,
    claudeHooks: claudeHooksStatus.installed ? { installed: claudeHooksStatus.managedCount } : null,
    codexHooks: codexInstalled ? { installed: 4 } : null,
    grokHooks: grokHooksStatus.installed ? { installed: grokHooksStatus.managedCount } : null,
    opencodePluginInstalled: fs.existsSync(OPENCODE_PLUGIN_TARGET),
    piExtensionInstalled: fs.existsSync(PI_EXTENSION_TARGET),
    args: {}
  });

  const state = cleanupStateSessions(readStateFile(), Date.now());
  const sessions = Object.values(state.sessions).sort((a, b) => b.updated_at - a.updated_at);
  const activities = sessions.map((s) => sessionToActivityItem(s));

  const rawQuotas = await fetchAllHarnessQuotas();
  const quotas = rawQuotas.map((q) => ({
    tool: q.tool,
    status: q.status === 'active' ? success('✔ Active') : dim('· Unavailable'),
    detail: q.status === 'active' ? q.text : dim(q.text)
  }));

  console.log(renderStatusSummary({
    appTitle: APP_TITLE,
    version: VERSION,
    author: APP_AUTHOR,
    system: [
      {
        name: 'Startup',
        status: installed ? success('✔ Active') : warning('✖ Not installed'),
        target: accent(compactHomePath(target || 'not configured'))
      },
      {
        name: 'Config',
        status: fs.existsSync(CONFIG_FILE) ? success('✔ Loaded') : dim('· Default'),
        target: accent(compactHomePath(CONFIG_FILE))
      },
      {
        name: 'State store',
        status: success('✔ Active'),
        target: accent(compactHomePath(STATE_FILE))
      }
    ],
    tools,
    quotas,
    activities
  }));
}

function codexHookCommand(scriptPath: string, event: string): string {
  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'codex-hook',
    '--event',
    shellQuoteArg(event)
  ].join(' ');
}

function readCodexHooks(): Record<string, unknown> {
  if (!fs.existsSync(CODEX_HOOKS_FILE)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CODEX_HOOKS_FILE, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    logError('Failed to read Codex hooks configuration', error);
    return {};
  }
}

function writeCodexHooks(hooks: Record<string, unknown>): void {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.writeFileSync(CODEX_HOOKS_FILE, `${JSON.stringify(hooks, null, 2)}\n`);
}

function installCodexHooks(scriptPath: string): { hooksFile: string; installed: number; removed: number } {
  const existing = readCodexHooks();
  const hooks = asRecord(existing.hooks) || {};
  let removed = 0;

  for (const event of CODEX_HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const filtered = list.filter((item) => {
      const record = asRecord(item);
      const commandText = typeof record?.command === 'string' ? record.command : '';
      const matchesManagedHook = commandText.includes('codex-hook')
        && (commandText.includes(APP_ID) || commandText.includes(APP_TITLE));

      if (matchesManagedHook) {
        removed += 1;
      }
      return !matchesManagedHook;
    });

    filtered.push({
      command: codexHookCommand(scriptPath, event),
      statusMessage: APP_TITLE
    });
    hooks[event] = filtered;
  }

  existing.hooks = hooks;
  writeCodexHooks(existing);
  return {
    hooksFile: CODEX_HOOKS_FILE,
    installed: CODEX_HOOK_EVENTS.length,
    removed
  };
}

function uninstallCodexHooks(): { hooksFile: string; removed: number } {
  const existing = readCodexHooks();
  const hooks = asRecord(existing.hooks) || {};
  let removed = 0;

  for (const event of CODEX_HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const filtered = list.filter((item) => {
      const record = asRecord(item);
      const commandText = typeof record?.command === 'string' ? record.command : '';
      const matchesManagedHook = commandText.includes('codex-hook')
        && (commandText.includes(APP_ID) || commandText.includes(APP_TITLE));

      if (matchesManagedHook) {
        removed += 1;
      }
      return !matchesManagedHook;
    });

    if (filtered.length > 0) {
      hooks[event] = filtered;
    } else {
      delete hooks[event];
    }
  }

  if (Object.keys(hooks).length > 0) {
    existing.hooks = hooks;
  } else {
    delete existing.hooks;
  }

  writeCodexHooks(existing);
  return {
    hooksFile: CODEX_HOOKS_FILE,
    removed
  };
}

function printCodexHooksStatus(): void {
  const hooks = asRecord(readCodexHooks().hooks) || {};
  const managedHooks: Record<string, string[]> = {};
  let managedCount = 0;

  for (const event of CODEX_HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const matching = list
      .map((item) => {
        const record = asRecord(item);
        const commandText = typeof record?.command === 'string' ? record.command : '';
        const statusMessage = typeof record?.statusMessage === 'string' ? record.statusMessage : '';
        return statusMessage === APP_TITLE || (commandText.includes('codex-hook') && commandText.includes(APP_ID))
          ? commandText
          : '';
      })
      .filter(Boolean);

    if (matching.length > 0) {
      managedHooks[event] = matching;
      managedCount += matching.length;
    }
  }

  console.log(JSON.stringify({
    codexHome: CODEX_HOME,
    hooksFile: CODEX_HOOKS_FILE,
    hooksFileExists: fs.existsSync(CODEX_HOOKS_FILE),
    installed: managedCount > 0,
    managedCount,
    expectedEvents: CODEX_HOOK_EVENTS,
    managedHooks
  }, null, 2));
}

function claudeHookCommand(scriptPath: string, event: string): string {
  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'claude-hook',
    '--event',
    shellQuoteArg(event),
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

function printGrokHooksStatus(): void {
  const status = getManagedGrokHookStatus();
  console.log(JSON.stringify({
    grokHooksDir: GROK_HOOKS_DIR,
    hooksFile: GROK_HOOKS_FILE,
    hooksFileExists: fs.existsSync(GROK_HOOKS_FILE),
    expectedEvents: GROK_HOOK_EVENTS,
    ...status
  }, null, 2));
}

const command = process.argv[2] || '';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));

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
    grokClientId: GROK_CLIENT_ID,
    cursorClientId: CURSOR_CLIENT_ID,
    configFile: CONFIG_FILE,
    stateFile: STATE_FILE
  })) {
    process.exit(process.exitCode || 0);
  }

  if (await runConfigCommand(command, args, {
    appTitle: APP_TITLE,
    configFile: CONFIG_FILE,
    readExistingConfig: readSetupConfigEntries,
    writeConfig: writeConfigEntries,
    serializeConfig: serializeJsonConfig,
    compactEntries: compactConfigEntries,
    getPreviewLines: (existing) => configPreviewLines(existing, createConfigPreviewSamples()),
    runTui: (existing) => runConfigTui(existing, createConfigPreviewSamples(), APP_TITLE, CONFIG_FILE),
    runAdvancedEditor: (existing) => runAdvancedConfigEditor(existing, CONFIG_EDITOR_FIELDS, CONFIG_FILE)
  })) {
    process.exit(process.exitCode || 0);
  }

  if (await runSetupCommand(command, args, {
    appTitle: APP_TITLE,
    version: VERSION,
    author: APP_AUTHOR,
    configFile: CONFIG_FILE,
    stateFile: STATE_FILE,
    installDirectory: getInstallDirectory(),
    codexClientId: CODEX_CLIENT_ID,
    claudeClientId: CLAUDE_CLIENT_ID,
    opencodeClientId: OPENCODE_CLIENT_ID,
    piClientId: PI_CLIENT_ID,
    grokClientId: GROK_CLIENT_ID,
    providers: toolProviders,
    getDetections: () => detectSetupTools({
      executableOverrides: { codexCli: [CODEX_BIN] },
      pathOverrides: { codexHome: CODEX_HOME }
    }, toolProviders),
    printStatus: printStartupStatus,
    uninstallStartup,
    writeSetupConfig,
    copyRuntime: copyRuntimeToInstallDir,
    installStartup,
    installCodexHooks,
    installClaudeHooks,
    installGrokHooks: installManagedGrokHooks,
    isOpencodePluginInstalled: () => fs.existsSync(OPENCODE_PLUGIN_TARGET),
    isPiExtensionInstalled: () => fs.existsSync(PI_EXTENSION_TARGET),
    compactPath: compactHomePath,
    defaultStartupPath: process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'LaunchAgents', `${MACOS_LAUNCH_AGENT_ID}.plist`)
      : WINDOWS_TASK_NAME
  })) {
    process.exit(process.exitCode || 0);
  }

  if (runHooksCommand(command, {
    appTitle: APP_TITLE,
    getRuntimeScriptPath: copyRuntimeToInstallDir,
    codex: {
      install: installCodexHooks,
      uninstall: uninstallCodexHooks,
      printStatus: printCodexHooksStatus
    },
    claude: {
      install: installClaudeHooks,
      uninstall: uninstallClaudeHooks,
      printStatus: printClaudeHooksStatus
    },
    grok: {
      install: installManagedGrokHooks,
      uninstall: removeManagedGrokHooks,
      printStatus: printGrokHooksStatus
    }
  })) {
    process.exit(process.exitCode || 0);
  }

  if (runStateCommand(command, args, {
    stateFile: STATE_FILE,
    getState: () => cleanupStateSessions(readStateFile(), Date.now()),
    clearState: clearHookState,
    upsertState: upsertHookState,
    getCodexSession: codexHookSessionFromArgs,
    getClaudeSession: claudeHookSessionFromArgs,
    getGrokSession: grokHookSessionFromArgs,
    getGenericSession: sessionFromArgs,
    isGrokAncestry: isGrokProcessAncestry
  })) {
    process.exit(process.exitCode || 0);
  }

  if (await runQuotaCommand(command, args, {
    getClaudeQuota: async () => {
      const result = await claudeQuotaEngine.getQuota(claudeQuotaRequestOptions());
      return {
        status: result.status,
        diagnostic: result.diagnostic || undefined,
        quota: result.quota ? { text: result.quota.text } : undefined
      };
    },
    getCodexQuota: (source) => {
      const normalizedSource = normalizeCodexQuotaSource(source || CODEX_QUOTA_SOURCE);
      return getNativeCodexQuotaText({ ...requireToolPresence('codexCli') }, normalizedSource);
    },
    getGrokQuota: () => getNativeGrokQuotaText(requireToolPresence('grokCli')),
    getOpencodeQuota: () => getNativeOpencodeQuotaText(requireToolPresence('opencodeCli')),
    getCursorQuota: () => getNativeCursorQuotaText(requireToolPresence('cursorCli')),
    defaultCodexSource: CODEX_QUOTA_SOURCE
  })) {
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
