#!/usr/bin/env node
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readlineCore from 'node:readline';
import * as readline from 'node:readline/promises';
import { exec, execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import DiscordRPC from 'discord-rpc';
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
  detectActiveTools
} from './core/detection/active-tools';
import {
  DEFAULT_CLAUDE_CLIENT_ID,
  DEFAULT_CODEX_CLIENT_ID,
  findToolProviderByAlias,
  requireToolPresence,
  toolProviders
} from './providers/registry';
import {
  discordApplicationForTool,
  resolveDiscordApplications
} from './providers/discord';
import {
  getCwdForProcess,
  getProcessList
} from './adapters/system/processes';
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
  DEFAULT_CLAUDE_CONFIG_DIR,
  DEFAULT_CODEX_AUTH_FILE,
  DEFAULT_CODEX_QUOTA_SOURCE,
  DEFAULT_DETAIL_LEVEL,
  ENV_CONFIG_ALIASES,
  createConfigEditorFields
} from './commands/config/schema';
import {
  defaultDisplayLayout,
  displayLayoutFromEntries,
  displaySettingFromEnvironment,
  envPathValue,
  envValue,
  loadEnvironmentFiles,
  normalizeActivityStyle,
  normalizeCodexQuotaSource,
  normalizeDetailLevel,
  parseDotEnv,
  parseBoolean,
  parseOptionalBoolean,
  readJsonConfigFile,
  resolveHomePath
} from './commands/config/settings';
import type { SetupToolDetection } from './core/detection/types';
import type { HookSessionState, HookStateFile } from './core/hooks/types';
import type {
  CodexOAuthCredentials,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotSource,
  CodexQuotaSource,
  CodexQuotaWindow,
  PendingJsonRpcRequest
} from './core/quota/types';
import type {
  PackageInfo,
  PresenceMetadata,
  PresencePayload,
  RichStateParts
} from './core/presence/types';
import type {
  ActiveTool,
  ToolDefinition,
  ToolFamily
} from './core/tools/types';
import type { RpcConnectionState } from './adapters/discord/types';
import type { DaemonRefreshResult } from './adapters/startup/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const APP_ID = 'discord-coding-status';
const APP_TITLE = 'Discord Coding Status';
const APP_AUTHOR = '@howznguyen';
const APP_WEBSITE = 'https://howznguyen.dev/projects/discord-coding-status';
const APP_REPOSITORY = 'https://github.com/howznguyen/discord-coding-status';
const APP_LICENSE = 'MIT';
const MACOS_LAUNCH_AGENT_ID = 'io.github.discord-coding-status.daemon';
const WINDOWS_TASK_NAME = 'DiscordCodingStatus';
const USER_DATA_DIR = path.join(os.homedir(), APP_ID);
const CONFIG_DIR = getConfigDirectory();
const CONFIG_FILE = path.join(USER_DATA_DIR, 'config.json');
const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, '.env');
const DEFAULT_STATE_FILE = path.join(USER_DATA_DIR, 'states.json');
const CONFIG_EDITOR_FIELDS: ConfigEditorField[] = createConfigEditorFields(DEFAULT_STATE_FILE);
const CODEX_HOME = resolveHomePath(process.env.CODEX_HOME || '~/.codex');
const CODEX_HOOKS_FILE = path.join(CODEX_HOME, 'hooks.json');
const CLAUDE_CONFIG_DIR = resolveHomePath(process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR);
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_CONFIG_DIR, 'settings.json');
const CLAUDE_CREDENTIALS_FILE = path.join(CLAUDE_CONFIG_DIR, '.credentials.json');
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
] as const;

loadEnvironmentFiles(CONFIG_FILE, LEGACY_CONFIG_FILE, process.cwd(), logError);

const DISCORD_APPLICATIONS = resolveDiscordApplications(toolProviders, envValue);
const CODEX_CLIENT_ID = DISCORD_APPLICATIONS.get('codex')?.clientId || '';
const CLAUDE_CLIENT_ID = DISCORD_APPLICATIONS.get('claude')?.clientId || '';
const FALLBACK_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '').trim();
const LARGE_IMAGE_KEY = (process.env.DISCORD_LARGE_IMAGE_KEY || '').trim();
const SMALL_IMAGE_KEY = (process.env.DISCORD_SMALL_IMAGE_KEY || '').trim();
const DETAIL_LEVEL = normalizeDetailLevel(envValue('DISCORD_CODING_STATUS_DETAIL_LEVEL', DEFAULT_DETAIL_LEVEL));
const PROJECT_NAME_OVERRIDE = envValue('DISCORD_CODING_STATUS_PROJECT_NAME').trim();
const PACKAGE_NAME_OVERRIDE = envValue('DISCORD_CODING_STATUS_PACKAGE_NAME').trim();
const USAGE_TEXT = envValue('DISCORD_CODING_STATUS_USAGE_TEXT').trim();
const USAGE_COMMAND = envValue('DISCORD_CODING_STATUS_USAGE_COMMAND').trim();
const CODEX_QUOTA_SOURCE = normalizeCodexQuotaSource(envValue('DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE', DEFAULT_CODEX_QUOTA_SOURCE));
const CODEX_BIN = envValue('DISCORD_CODING_STATUS_CODEX_BIN', 'codex').trim() || 'codex';
const CODEX_AUTH_FILE = resolveHomePath(envValue('DISCORD_CODING_STATUS_CODEX_AUTH_FILE', DEFAULT_CODEX_AUTH_FILE));
const CODEX_API_BASE_URL = envValue('DISCORD_CODING_STATUS_CODEX_API_BASE_URL', 'https://chatgpt.com/backend-api').trim().replace(/\/$/, '');
const CODEX_OAUTH_CLIENT_ID = envValue('DISCORD_CODING_STATUS_CODEX_OAUTH_CLIENT_ID', 'app_EMoamEEZ73f0CkXaXp7hrann').trim();
const PLAN_TEXT_OVERRIDE = envValue('DISCORD_CODING_STATUS_PLAN_TEXT').trim().replace(/\\\$/g, '$');
const LIMITS_TEXT_OVERRIDE = envValue('DISCORD_CODING_STATUS_LIMITS_TEXT').trim();
const PREFER_CODEX_CLI = parseBoolean(envValue('DISCORD_CODING_STATUS_PREFER_CODEX_CLI'));
const ACTIVITY_STYLE = normalizeActivityStyle(
  envValue('DISCORD_CODING_STATUS_ACTIVITY_STYLE', DEFAULT_ACTIVITY_STYLE)
);
const SHOW_ACTIVITY = displaySettingFromEnvironment('DISCORD_CODING_STATUS_SHOW_ACTIVITY', true);
const SHOW_PROJECT = displaySettingFromEnvironment(
  'DISCORD_CODING_STATUS_SHOW_PROJECT',
  DETAIL_LEVEL === 'project' || DETAIL_LEVEL === 'full'
);
const SHOW_MODEL = displaySettingFromEnvironment('DISCORD_CODING_STATUS_SHOW_MODEL', true);
const SHOW_QUOTA = displaySettingFromEnvironment(
  'DISCORD_CODING_STATUS_SHOW_QUOTA',
  DETAIL_LEVEL === 'project' || DETAIL_LEVEL === 'full'
);
const SHOW_CONTEXT = displaySettingFromEnvironment('DISCORD_CODING_STATUS_SHOW_CONTEXT', false);
const SHOW_PACKAGE = displaySettingFromEnvironment(
  'DISCORD_CODING_STATUS_SHOW_PACKAGE',
  DETAIL_LEVEL === 'full'
);
const STATE_FILE = path.resolve(resolveHomePath(envPathValue('DISCORD_CODING_STATUS_STATE_FILE', DEFAULT_STATE_FILE)));
const STATE_MAX_AGE_MS = Number(envValue('DISCORD_CODING_STATUS_STATE_MAX_AGE_MS', String(15 * 60_000)));
const STATE_LOCK_TIMEOUT_MS = Number(envValue('DISCORD_CODING_STATUS_STATE_LOCK_TIMEOUT_MS', '2000'));

const POLL_INTERVAL_OVERRIDE_MS = Number(
  envValue('DISCORD_CODING_STATUS_POLL_INTERVAL_MS', '10000')
);
const POLL_INTERVAL_MS = Number.isFinite(POLL_INTERVAL_OVERRIDE_MS)
  ? Math.max(100, POLL_INTERVAL_OVERRIDE_MS)
  : 10_000;
const STATE_WATCH_DEBOUNCE_MS = 25;
const PROCESS_DETECTION_ENABLED = envValue(
  'DISCORD_CODING_STATUS_PROCESS_DETECTION',
  'on'
).trim().toLowerCase() !== 'off';
const DEBUG_ENABLED = envValue('DISCORD_CODING_STATUS_DEBUG').trim().toLowerCase() === '1';
const RECONNECT_INTERVAL_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
const USAGE_TIMEOUT_MS = Number(envValue('DISCORD_CODING_STATUS_USAGE_TIMEOUT_MS', '8000'));
const USAGE_REFRESH_INTERVAL_MS = Number(envValue('DISCORD_CODING_STATUS_USAGE_REFRESH_INTERVAL_MS', '60000'));
const MAX_PRESENCE_TEXT_LENGTH = 128;
const VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf8')) as {
      version?: unknown;
    };

    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

function getPackageRoot(): string {
  return path.basename(__dirname) === 'dist' ? path.dirname(__dirname) : __dirname;
}

function getConfigDirectory(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_ID);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_ID);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_ID);
}

const STATUS_MESSAGES: Record<string, string[]> = {
  active: [
    'Vibing responsibly',
    'Shipping confidence',
    'Turning coffee into diffs',
    'Pretending this was planned',
    'Debugging with main character energy',
    'Making the repo look employed',
    'Asking AI nicely',
    'Keeping the syntax hydrated',
    'Pushing pixels and promises',
    'Building features with suspicious calm'
  ],
  running: [
    'Cooking tokens',
    'Negotiating with TypeScript',
    'Letting the model cook',
    'Running on caffeine and context',
    'Producing a diff with legal tender energy',
    'Trying not to invent a framework',
    'Compiling brave ideas',
    'Refactoring reality',
    'Making localhost feel important',
    'Convincing tests to be reasonable'
  ],
  thinking: [
    'Overthinking professionally',
    'Staring at context like it owes money',
    'Calculating semicolon risk',
    'Reading the repo before touching it',
    'Consulting the inner stack trace',
    'Finding the least dramatic fix',
    'Measuring twice, patching once',
    'Profiling the vibes',
    'Waiting for the obvious answer to arrive',
    'Doing senior-engineer silence'
  ],
  streaming: [
    'Typing with confidence',
    'Generating tasteful chaos',
    'Printing tokens with intent',
    'Turning prompts into receipts',
    'Writing code at conversational speed',
    'Letting the cursor sprint',
    'Autocompleting destiny',
    'Making stdout earn rent',
    'Delivering the diff live',
    'Streaming probable solutions'
  ],
  waiting: [
    'Waiting dramatically',
    'Holding the cursor hostage',
    'Standing by with a clean diff',
    'Ready for the next brilliant demand',
    'Waiting like CI on a Friday',
    'Keeping the prompt warm',
    'Paused at the edge of greatness',
    'Letting the user cook',
    'Maintaining professional suspense',
    'Idle but emotionally available'
  ],
  waiting_input: [
    'Your move, captain',
    'Awaiting the next plot twist',
    'Waiting for instructions with posture',
    'The prompt ball is on your side',
    'Ready when the keyboard is',
    'Standing by for fresh context',
    'Holding position at line zero',
    'Waiting for a very important sentence',
    'Input requested, confidence preserved',
    'One more prompt from greatness'
  ],
  waiting_approval: [
    'Needs a permission slip',
    'Waiting for the adult in the room',
    'Asking before touching the sharp tools',
    'Permission gate doing permission things',
    'Awaiting the sacred yes',
    'Paused at the policy checkpoint',
    'Holding the risky command politely',
    'Needs a nod before the diff party',
    'Approval pending, hands visible',
    'Standing outside sudo with respect'
  ],
  idle: [
    'On a tiny coffee break',
    'Resting the context window',
    'Idle, but still judging tabs',
    'Saving tokens for something dramatic',
    'Taking a compile-length breath',
    'Not frozen, just minimalist',
    'Charging the next idea',
    'Quietly not breaking production',
    'Letting the repo cool down',
    'Practicing restraint'
  ],
  paused: [
    'Paused mid-genius',
    'Suspended between two better ideas',
    'Parking the brain process',
    'Holding that thought in RAM',
    'Paused for dramatic indentation',
    'Keeping the half-diff fresh',
    'Waiting for the next commit arc',
    'Temporarily not making things worse',
    'Break-pointing real life',
    'Paused with intent'
  ],
  error: [
    'Tripped on a semicolon',
    'Currently negotiating with failure',
    'The stack trace has opinions',
    'Something yelled in red',
    'Reality returned non-zero',
    'Bug found, ego patched',
    'The happy path filed a complaint',
    'Unhandled ambition detected',
    'Compiler said no with confidence',
    'Debugging the emotional damage'
  ]
};

const TERMINAL_STATUSES = new Set([
  'done',
  'complete',
  'completed',
  'stopped',
  'exited',
  'closed',
  'clear',
  'cleared'
]);

const rpcConnections = new Map<string, RpcConnectionState>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let stateWatcher: import('node:fs').FSWatcher | null = null;
let stateWatchTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
const cachedUsageTextByKey = new Map<string, { text: string | null; fetchedAt: number }>();
const usageRefreshesByKey = new Map<string, Promise<void>>();
const claudeUsageRevisionBySession = new Map<string, number>();

function dim(value: string): string {
  return chalk.dim(value);
}

function success(value: string): string {
  return chalk.green(value);
}

function warning(value: string): string {
  return chalk.yellow(value);
}

function danger(value: string): string {
  return chalk.red(value);
}

function accent(value: string): string {
  return chalk.cyan(value);
}

function title(value: string): string {
  return chalk.bold.cyan(value);
}

function shouldShowProject(): boolean {
  return SHOW_PROJECT;
}

function shouldShowPackage(): boolean {
  return SHOW_PACKAGE;
}

function shouldShowUsage(): boolean {
  return SHOW_QUOTA;
}

function truncatePresenceText(value: string | null | undefined): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  if (text.length <= MAX_PRESENCE_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_PRESENCE_TEXT_LENGTH - 3)}...`;
}

function sanitizeProjectName(value: string | null | undefined): string | null {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const basename = path.basename(text);
  const cleaned = basename
    .replace(/[^\w .@-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || ['/', '.', 'contents', 'resources', 'macos'].includes(cleaned.toLowerCase())) {
    return null;
  }

  return truncatePresenceText(cleaned);
}

function sanitizePackageName(value: string | null | undefined): string | null {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return null;
  }

  return truncatePresenceText(text.replace(/[^\w .@/-]/g, ''));
}

function formatContextText(value: string | null | undefined): string | null {
  const text = String(value || '')
    .replace(/^(?:ctx|context)\s*[:=]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return null;
  }

  const amount = '\\d+(?:\\.\\d+)?(?:%|[kKmMbB]?(?:\\s*(?:tok|tokens?))?)';
  const metricPattern = new RegExp(`^${amount}(?:\\s*\\/\\s*${amount})?$`, 'i');
  if (!metricPattern.test(text)) {
    return null;
  }

  return truncatePresenceText(`ctx ${text}`);
}

function sanitizeBranchName(value: string | null | undefined): string | null {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const cleaned = text
    .replace(/[^\w./@+-]/g, '')
    .replace(/^refs\/heads\//, '')
    .trim();

  return cleaned ? truncatePresenceText(cleaned) : null;
}

function joinPresenceParts(parts: Array<string | null | undefined>): string {
  return truncatePresenceText(parts.filter(Boolean).join(' | '));
}

function joinMetricParts(parts: Array<string | null | undefined>): string {
  return truncatePresenceText(parts.filter(Boolean).join(' • '));
}

function formatDollar(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return `$${value.toFixed(2)}`;
}

function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B tok`;
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M tok`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K tok`;
  }

  return `${Math.round(value)} tok`;
}

function capitalizeWord(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function normalizeStatus(value: string | null | undefined): string {
  return String(value || 'active').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash);
}

function pickTimedMessage(key: string, messages: string[]): string {
  if (!messages.length) {
    return '';
  }

  const tenMinuteBucket = Math.floor(Date.now() / (10 * 60_000));
  return messages[hashString(`${key}:${tenMinuteBucket}`) % messages.length];
}

function statusLabel(value: string | null | undefined): string | null {
  const normalized = normalizeStatus(value);
  const known = STATUS_MESSAGES[normalized];

  if (known) {
    return pickTimedMessage(normalized, known);
  }

  const cleaned = normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  return cleaned || null;
}

function styledStatusLabel(
  value: string | null | undefined,
  style: ActivityStyle = ACTIVITY_STYLE
): string | null {
  if (style === 'fun') {
    return statusLabel(value);
  }

  const normalized = normalizeStatus(value);
  if (style === 'minimal') {
    if (normalized === 'thinking') {
      return 'Thinking';
    }
    if (['waiting', 'waiting_input', 'waiting_approval'].includes(normalized)) {
      return 'Waiting';
    }
    if (['idle', 'paused'].includes(normalized)) {
      return 'Idle';
    }
    if (normalized === 'error') {
      return 'Error';
    }
    return 'Working';
  }

  const labels: Record<string, string> = style === 'technical'
    ? {
        active: 'Active session',
        running: 'Running',
        thinking: 'Model thinking',
        streaming: 'Streaming output',
        waiting: 'Waiting',
        waiting_input: 'Waiting for input',
        waiting_approval: 'Permission requested',
        idle: 'Session idle',
        paused: 'Session paused',
        error: 'Session error'
      }
    : {
        active: 'Working',
        running: 'Working',
        thinking: 'Thinking',
        streaming: 'Writing a response',
        waiting: 'Waiting',
        waiting_input: 'Waiting for input',
        waiting_approval: 'Waiting for approval',
        idle: 'Idle',
        paused: 'Paused',
        error: 'Handling an error'
      };

  return labels[normalized] || statusLabel(value);
}

function isTerminalStatus(value: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(value));
}

function readStateFile(): HookStateFile {
  if (!fs.existsSync(STATE_FILE)) {
    return { version: 1, sessions: {} };
  }

  try {
    const content = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (!content) {
      return { version: 1, sessions: {} };
    }

    const parsed = JSON.parse(content) as Partial<HookStateFile>;
    if (!parsed || typeof parsed !== 'object' || !parsed.sessions || typeof parsed.sessions !== 'object') {
      return { version: 1, sessions: {} };
    }

    return {
      version: 1,
      sessions: parsed.sessions as Record<string, HookSessionState>
    };
  } catch (error) {
    logError('Failed to read state file', error);
    return { version: 1, sessions: {} };
  }
}

function writeStateFile(state: HookStateFile): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const tmpPath = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmpPath, STATE_FILE);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStateLock<T>(operation: () => T): T {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const lockPath = `${STATE_FILE}.lock`;
  const startedAt = Date.now();
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n`);
    } catch (error) {
      if (Date.now() - startedAt > STATE_LOCK_TIMEOUT_MS) {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > STATE_LOCK_TIMEOUT_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (_) {
          continue;
        }

        throw error;
      }

      sleepSync(25);
    }
  }

  try {
    return operation();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }

    try {
      fs.unlinkSync(lockPath);
    } catch (_) {
      // Another process may have cleaned a stale lock.
    }
  }
}

function cleanupStateSessions(state: HookStateFile, now = Date.now()): HookStateFile {
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([, session]) => {
      if (!session || typeof session !== 'object') {
        return false;
      }

      if (isTerminalStatus(session.status)) {
        return false;
      }

      if (!session.updated_at || now - session.updated_at > STATE_MAX_AGE_MS) {
        return false;
      }

      return true;
    })
  );

  return { version: 1, sessions };
}

function readOptionalStdin(): string {
  try {
    if (!process.stdin.isTTY) {
      return fs.readFileSync(0, 'utf8');
    }
  } catch (_) {
    // No readable stdin for manual invocations.
  }

  return '';
}

function readHookInput(): Record<string, unknown> {
  const stdin = readOptionalStdin().trim();
  if (!stdin) {
    return {};
  }

  try {
    const parsed = JSON.parse(stdin);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch (_) {
    return {};
  }
}

function findStringDeep(value: unknown, keys: string[], depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 4) {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === 'string' && found.trim()) {
      return found.trim();
    }
  }

  for (const nested of Object.values(record)) {
    const found = findStringDeep(nested, keys, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function readCodexTurnMetadata(transcriptPath: string | null): { model: string | null; effort: string | null } {
  const unavailable = { model: null, effort: null };
  if (!transcriptPath) {
    return unavailable;
  }

  let fd: number | null = null;

  try {
    const resolvedPath = path.resolve(resolveHomePath(transcriptPath));
    const stat = fs.statSync(resolvedPath);
    const maxBytes = 2 * 1024 * 1024;
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(resolvedPath, 'r');
    fs.readSync(fd, buffer, 0, length, start);

    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }

    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }

      try {
        const record = asRecord(JSON.parse(line));
        if (!record || record.type !== 'turn_context') {
          continue;
        }

        const payload = asRecord(record.payload);
        if (!payload) {
          continue;
        }

        return {
          model: extractString(payload.model),
          effort: extractString(
            payload.effort
              ?? payload.reasoning_effort
              ?? payload.reasoningEffort
              ?? payload.model_reasoning_effort
              ?? payload.modelReasoningEffort
          )
        };
      } catch (_) {
        // Ignore incomplete or non-JSON transcript lines while scanning backwards.
      }
    }
  } catch (error) {
    debugLog(`Codex transcript metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // Best effort cleanup for a local transcript read.
      }
    }
  }

  return unavailable;
}

function safeCommandSummary(command: string | null): string | null {
  if (!command) {
    return null;
  }

  const tokens = command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  if (!tokens.length) {
    return null;
  }

  const executable = path.basename(tokens[0]);
  if (!/^[\w.+-]+$/.test(executable)) {
    return null;
  }

  const safeArgs = tokens
    .slice(1, 3)
    .filter((token) => /^[\w:@+-]+$/.test(token) && !/[=]/.test(token));

  return [executable, ...safeArgs].join(' ');
}

function pickHookActivity(key: string, messages: string[]): string {
  return pickTimedMessage(`hook:${key}`, messages);
}

function conventionalCodexHookActivity(
  event: string,
  toolName: string | null,
  command: string | null,
  style: Exclude<ActivityStyle, 'fun'>
): string | null {
  const normalized = event.trim().toLowerCase();

  if (style === 'minimal') {
    if (normalized === 'permissionrequest' || normalized === 'permission_request') {
      return 'Waiting';
    }
    if (normalized === 'stop') {
      return 'Idle';
    }
    if (normalized === 'sessionstart' || normalized === 'session_start') {
      return 'Starting';
    }
    return 'Working';
  }

  if (normalized === 'permissionrequest' || normalized === 'permission_request') {
    return style === 'technical' ? 'Permission requested' : 'Waiting for approval';
  }

  if (normalized === 'stop') {
    return style === 'technical' ? 'Codex idle' : 'Waiting for input';
  }

  if (normalized === 'pretooluse' || normalized === 'pre_tool_use') {
    if (style === 'technical') {
      return command ? `Running ${command}` : (toolName ? `Running ${toolName}` : 'Tool running');
    }
    return toolName ? `Using ${toolName}` : 'Running a command';
  }

  if (normalized === 'posttooluse' || normalized === 'post_tool_use') {
    if (style === 'technical') {
      return toolName ? `Finished ${toolName}` : 'Tool finished';
    }
    return 'Command completed';
  }

  if (normalized === 'userpromptsubmit' || normalized === 'user_prompt_submit') {
    return style === 'technical' ? 'Prompt submitted' : 'Processing prompt';
  }

  if (normalized === 'sessionstart' || normalized === 'session_start') {
    return style === 'technical' ? 'Session started' : 'Starting Codex session';
  }

  return null;
}

function activityFromCodexHook(event: string, input: Record<string, unknown>): string | null {
  const normalized = event.trim().toLowerCase();
  const toolName = findStringDeep(input, ['tool_name', 'toolName', 'tool']);
  const command = safeCommandSummary(findStringDeep(input, ['command', 'cmd']));

  if (ACTIVITY_STYLE !== 'fun') {
    return conventionalCodexHookActivity(event, toolName, command, ACTIVITY_STYLE);
  }

  if (normalized === 'permissionrequest' || normalized === 'permission_request') {
    return pickHookActivity('permission', [
      'Waiting for the sacred yes',
      'Permission checkpoint in progress',
      'Holding the risky command politely',
      'Approval pending, hands visible',
      'Standing outside sudo with respect'
    ]);
  }

  if (normalized === 'stop') {
    return pickHookActivity('stop', [
      'Waiting for the next plot twist',
      'Your move, captain',
      'Standing by with a clean diff',
      'Prompt ball is on your side',
      'Ready when the keyboard is'
    ]);
  }

  if (normalized === 'pretooluse' || normalized === 'pre_tool_use') {
    if (command) {
      return pickHookActivity(`pre-command:${command}`, [
        `Running ${command}`,
        `Letting ${command} cook`,
        `Giving ${command} the keyboard`,
        `Convincing ${command} to behave`,
        `Escorting ${command} through reality`
      ]);
    }

    return toolName
      ? pickHookActivity(`pre-tool:${toolName}`, [
        `Running ${toolName}`,
        `Letting ${toolName} earn its keep`,
        `Putting ${toolName} to work`,
        `Asking ${toolName} politely`,
        `Sending ${toolName} into the codebase`
      ])
      : pickHookActivity('pre-tool', [
        'Running a tool',
        'Doing tool-shaped work',
        'Consulting the toolbox',
        'Making the machine useful',
        'Executing the next tiny plan'
      ]);
  }

  if (normalized === 'posttooluse' || normalized === 'post_tool_use') {
    return toolName
      ? pickHookActivity(`post-tool:${toolName}`, [
        `Finished ${toolName}`,
        `${toolName} returned receipts`,
        `${toolName} survived the assignment`,
        `${toolName} handed back the clipboard`,
        `${toolName} did the thing`
      ])
      : pickHookActivity('post-tool', [
        'Finished tool work',
        'Tool returned receipts',
        'One tiny plan completed',
        'The tool did the thing',
        'Back from the tool trip'
      ]);
  }

  if (normalized === 'userpromptsubmit' || normalized === 'user_prompt_submit') {
    return pickHookActivity('prompt', [
      'Processing a fresh prompt',
      'Reading the new plot twist',
      'Turning words into work',
      'Parsing ambition',
      'Loading context with intent'
    ]);
  }

  if (normalized === 'sessionstart' || normalized === 'session_start') {
    return pickHookActivity('session-start', [
      'Codex session started',
      'Opening a clean context window',
      'New session, fresh confidence',
      'Booting the coding cockpit',
      'Starting the next diff arc'
    ]);
  }

  return null;
}

function findCodexAncestorPid(startPid = process.ppid): number {
  let currentPid = startPid;

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const output = execFileSyncString('ps', ['-p', String(currentPid), '-o', 'ppid=,comm=,args=']);
      const line = output.trim();
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return currentPid;
      }

      const parentPid = Number(match[1]);
      const commandText = match[2].toLowerCase();

      if (/(^|[\s/])codex($|[\s/.-])/.test(commandText) || commandText.includes('/codex.app/')) {
        return currentPid;
      }

      if (!parentPid || parentPid === currentPid) {
        return currentPid;
      }

      currentPid = parentPid;
    } catch (_) {
      return currentPid;
    }
  }

  return currentPid;
}

function execFileSyncString(
  command: string,
  args: string[],
  timeout = 1_000,
  maxBuffer = 64 * 1024
): string {
  const result = execFileSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'ignore']
  });

  return typeof result === 'string' ? result : String(result);
}

function buildSessionId(state: Pick<HookSessionState, 'tool' | 'surface' | 'cwd'>): string {
  return `${state.tool}:${state.surface}:${state.cwd}`;
}

function coerceStateTimestamp(value: unknown, fallback?: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const now = Date.now();
    return value <= now + 60_000 ? Math.round(value) : fallback;
  }

  return fallback;
}

function coerceHookSessionState(value: unknown): HookSessionState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const input = value as Partial<HookSessionState>;
  const tool = String(input.tool || '').trim().toLowerCase();
  const surface = String(input.surface || 'cli').trim().toLowerCase();
  const status = normalizeStatus(input.status);
  const cwd = path.resolve(String(input.cwd || process.cwd()));
  const session_id = String(input.session_id || buildSessionId({ tool, surface, cwd })).trim();
  const now = Date.now();
  const updated_at = coerceStateTimestamp(input.updated_at, now) || now;
  const started_at = coerceStateTimestamp(input.started_at);

  if (!tool || !surface || !session_id) {
    return null;
  }

  return {
    tool,
    surface,
    status,
    session_id,
    cwd,
    updated_at,
    started_at,
    project: typeof input.project === 'string' ? input.project : undefined,
    package: typeof input.package === 'string' ? input.package : undefined,
    title: typeof input.title === 'string' ? input.title : undefined,
    activity: typeof input.activity === 'string' ? input.activity : undefined,
    model: typeof input.model === 'string' ? input.model : undefined,
    effort: typeof input.effort === 'string' ? input.effort : undefined,
    context: typeof input.context === 'string' ? input.context : undefined,
    claude_quota_eligible: typeof input.claude_quota_eligible === 'boolean'
      ? input.claude_quota_eligible
      : undefined
  };
}

function sessionFromArgs(args: Record<string, string | boolean>): HookSessionState | null {
  const json = getArgString(args, 'json');
  if (json) {
    try {
      return coerceHookSessionState(JSON.parse(json));
    } catch (error) {
      logError('Invalid hook JSON', error);
      return null;
    }
  }

  return coerceHookSessionState({
    tool: getArgString(args, 'tool'),
    surface: getArgString(args, 'surface') || 'cli',
    status: getArgString(args, 'status') || 'active',
    session_id: getArgString(args, 'session-id') || getArgString(args, 'session_id') || undefined,
    cwd: getArgString(args, 'cwd') || process.cwd(),
    project: getArgString(args, 'project') || undefined,
    package: getArgString(args, 'package') || undefined,
    title: getArgString(args, 'title') || undefined,
    activity: getArgString(args, 'activity') || undefined,
    model: getArgString(args, 'model') || undefined,
    effort: getArgString(args, 'effort')
      || getArgString(args, 'reasoning-effort')
      || getArgString(args, 'model-reasoning-effort')
      || undefined,
    context: getArgString(args, 'context') || undefined
  });
}

function codexHookSessionFromArgs(args: Record<string, string | boolean>): HookSessionState {
  const input = readHookInput();
  const transcriptPath = findStringDeep(input, ['transcript_path', 'transcriptPath']);
  const turnMetadata = readCodexTurnMetadata(transcriptPath);
  const event = getArgString(args, 'event') || findStringDeep(input, ['event', 'hook_event', 'hookEvent']) || 'unknown';
  const status = getArgString(args, 'status') || statusFromCodexHookEvent(event);
  const cwd = path.resolve(
    getArgString(args, 'cwd')
      || findStringDeep(input, ['cwd', 'current_working_directory', 'working_directory', 'workspace'])
      || process.cwd()
  );
  const sessionId = getArgString(args, 'session-id')
    || getArgString(args, 'session_id')
    || findStringDeep(input, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId'])
    || `codex:cli:${cwd}:${findCodexAncestorPid()}`;

  return {
    tool: 'codex',
    surface: getArgString(args, 'surface') || 'cli',
    status,
    session_id: sessionId,
    cwd,
    updated_at: Date.now(),
    project: getArgString(args, 'project') || undefined,
    package: getArgString(args, 'package') || undefined,
    title: getArgString(args, 'title') || undefined,
    activity: getArgString(args, 'activity') || activityFromCodexHook(event, input) || undefined,
    model: getArgString(args, 'model')
      || findStringDeep(input, ['model', 'modelName', 'model_name'])
      || turnMetadata.model
      || undefined,
    effort: getArgString(args, 'effort')
      || getArgString(args, 'reasoning-effort')
      || findStringDeep(input, ['effort', 'reasoning_effort', 'reasoningEffort', 'model_reasoning_effort', 'modelReasoningEffort'])
      || turnMetadata.effort
      || undefined,
    context: getArgString(args, 'context') || findStringDeep(input, ['context', 'context_used', 'contextUsed']) || undefined
  };
}

function statusFromClaudeHookEvent(event: string): string {
  const normalized = event.trim().toLowerCase().replace(/_/g, '');

  if (normalized === 'sessionend') {
    return 'stopped';
  }

  if (normalized === 'notification') {
    return 'waiting_input';
  }

  return statusFromCodexHookEvent(event);
}

function activityFromClaudeHook(event: string, input: Record<string, unknown>): string | null {
  const activity = activityFromCodexHook(event, input);
  return activity ? activity.replace(/Codex/g, 'Claude Code') : null;
}

function claudeHookSessionFromArgs(args: Record<string, string | boolean>): HookSessionState {
  const input = readHookInput();
  const transcriptPath = findStringDeep(input, ['transcript_path', 'transcriptPath']);
  const event = getArgString(args, 'event')
    || findStringDeep(input, ['hook_event_name', 'hook_event', 'hookEvent', 'event'])
    || 'unknown';
  const cwd = path.resolve(
    getArgString(args, 'cwd')
      || findStringDeep(input, ['cwd', 'current_working_directory', 'working_directory', 'workspace'])
      || process.cwd()
  );
  const sessionId = getArgString(args, 'session-id')
    || getArgString(args, 'session_id')
    || extractClaudeSessionId(input)
    || findStringDeep(input, ['conversation_id', 'conversationId', 'thread_id', 'threadId'])
    || `claude:cli:${cwd}:${process.ppid}`;
  const model = getArgString(args, 'model')
    || extractClaudeModelFromHookInput(input)
    || readClaudeModelFromTranscript(transcriptPath)
    || undefined;
  const quotaRequestOptions = claudeQuotaRequestOptions();
  const eligibility = evaluateClaudeQuotaEligibility(
    quotaRequestOptions.environment || process.env,
    quotaRequestOptions.mode
  );

  return {
    tool: 'claude',
    surface: getArgString(args, 'surface') || 'cli',
    status: getArgString(args, 'status') || statusFromClaudeHookEvent(event),
    session_id: sessionId,
    cwd,
    updated_at: Date.now(),
    project: getArgString(args, 'project') || undefined,
    package: getArgString(args, 'package') || undefined,
    title: getArgString(args, 'title') || undefined,
    activity: getArgString(args, 'activity') || activityFromClaudeHook(event, input) || undefined,
    model,
    context: getArgString(args, 'context') || undefined,
    claude_quota_eligible: eligibility.eligible
  };
}

function statusFromCodexHookEvent(event: string): string {
  const normalized = event.trim().toLowerCase();

  if (normalized === 'permissionrequest' || normalized === 'permission_request') {
    return 'waiting_approval';
  }

  if (normalized === 'stop') {
    return 'waiting_input';
  }

  if (normalized === 'sessionstart' || normalized === 'session_start') {
    return 'running';
  }

  if (
    normalized === 'userpromptsubmit' ||
    normalized === 'user_prompt_submit' ||
    normalized === 'pretooluse' ||
    normalized === 'pre_tool_use' ||
    normalized === 'posttooluse' ||
    normalized === 'post_tool_use'
  ) {
    return 'running';
  }

  return 'active';
}

function isSameLogicalSession(left: HookSessionState, right: HookSessionState): boolean {
  return (
    left.tool === right.tool &&
    left.surface === right.surface &&
    path.resolve(left.cwd) === path.resolve(right.cwd)
  );
}

function findReusableSessionId(state: HookStateFile, session: HookSessionState): string | null {
  if (state.sessions[session.session_id]) {
    return session.session_id;
  }

  const matches = Object.entries(state.sessions)
    .filter(([, existing]) => isSameLogicalSession(existing, session));

  return matches.length === 1 ? matches[0][0] : null;
}

function upsertHookState(session: HookSessionState): void {
  withStateLock(() => {
    const now = Date.now();
    const state = cleanupStateSessions(readStateFile(), now);
    const reusableSessionId = findReusableSessionId(state, session);

    if (isTerminalStatus(session.status)) {
      delete state.sessions[session.session_id];
      if (reusableSessionId) {
        delete state.sessions[reusableSessionId];
      }
    } else {
      const reusableSession = reusableSessionId ? state.sessions[reusableSessionId] : null;
      const startedAt = coerceStateTimestamp(
        session.started_at,
        coerceStateTimestamp(reusableSession?.started_at, coerceStateTimestamp(reusableSession?.updated_at, now))
      ) || now;

      if (reusableSessionId && reusableSessionId !== session.session_id) {
        delete state.sessions[reusableSessionId];
      }

      state.sessions[session.session_id] = {
        ...reusableSession,
        ...session,
        model: session.model || reusableSession?.model,
        effort: session.effort || reusableSession?.effort,
        started_at: startedAt
      };
    }

    writeStateFile(state);
  });
}

function clearHookState(sessionId: string): void {
  withStateLock(() => {
    const state = readStateFile();
    delete state.sessions[sessionId];
    writeStateFile(cleanupStateSessions(state, Date.now()));
  });
}

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

function printSetupDetections(detections: SetupToolDetection[]): void {
  console.log(title('Detected tools:'));
  for (const item of detections) {
    const marker = item.detected ? success('found') : dim('not found');
    const detail = item.detail ? dim(` - ${item.detail}`) : '';
    console.log(`  ${marker} ${item.name}${detail}`);
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
  console.log(`${chalk.bold('File:')} ${accent(CONFIG_FILE)}`);
  console.log(dim('Enter keeps the current/default value. Use "-" to clear an override.'));
  console.log('');

  for (const field of CONFIG_EDITOR_FIELDS) {
    const override = entries[field.key] || '';
    const effective = override || field.defaultValue;
    const suffix = override ? '' : dim(' (default)');
    console.log(`  ${chalk.bold(field.label)}: ${formatConfigValue(effective)}${suffix}`);
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

function compactHomePath(value: string): string {
  const home = os.homedir();
  return home && value.startsWith(`${home}${path.sep}`)
    ? `~${path.sep}${value.slice(home.length + 1)}`
    : value;
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
    chalk.bold('LIVE PREVIEW') + dim('  sample data · Discord uses up to 128 characters per line'),
    `  ${dim('Top   ')} ${preview.top ? truncateTerminalText(preview.top, previewWidth) : dim('(hidden)')}`,
    `  ${dim('Bottom')} ${preview.bottom ? truncateTerminalText(preview.bottom, previewWidth) : dim('(hidden)')}`,
    ''
  ];
  let currentSection: ConfigTuiItem['section'] | null = null;

  CONFIG_TUI_ITEMS.forEach((item, index) => {
    if (item.section !== currentSection) {
      currentSection = item.section;
      lines.push(chalk.bold(item.section.toUpperCase()));
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

    const label = selected ? chalk.bold(item.label) : item.label;
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
    console.log(`${chalk.bold('Top:')} ${preview.top || dim('(hidden)')}`);
    console.log(`${chalk.bold('Bottom:')} ${preview.bottom || dim('(hidden)')}`);
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

function installWindowsScheduledTask(scriptPath: string, startNow: boolean): string {
  const launcherPath = writeWindowsLauncher(scriptPath);
  execFileSync('schtasks', [
    '/Create',
    '/TN',
    WINDOWS_TASK_NAME,
    '/SC',
    'ONLOGON',
    '/TR',
    `"${launcherPath}"`,
    '/F'
  ], { stdio: 'ignore' });

  if (startNow) {
    try {
      execFileSync('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore' });
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

function shellQuoteArg(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
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

function readClaudeSettings(): Record<string, unknown> {
  if (!fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    return {};
  }

  const parsed = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf8')) as unknown;
  return asRecord(parsed) || {};
}

function claudeQuotaRequestOptions(): import('./claude-quota').ClaudeQuotaRequestOptions {
  try {
    const settings = readClaudeSettings();
    const configuredEnvironment = asRecord(settings.env) || {};
    const environment: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(configuredEnvironment)) {
      if (
        typeof value === 'string'
        && value.trim()
        && !String(environment[key] || '').trim()
      ) {
        environment[key] = value;
      }
    }

    return {
      mode: extractString(settings.apiKeyHelper) ? 'api-key' : 'auto',
      environment
    };
  } catch (_) {
    return {
      mode: 'custom-provider',
      environment: process.env
    };
  }
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

  console.log(success(`${APP_TITLE} installed.`));
  printSetupDetections(detections);
  console.log(`${chalk.bold('Config:')} ${accent(CONFIG_FILE)}`);
  console.log(`${chalk.bold('Runtime:')} ${accent(scriptPath)}`);
  console.log(`${chalk.bold('Startup:')} ${accent(startupTarget)}`);
  if (codexHooks) {
    console.log(`${chalk.bold('Codex hooks:')} ${success(`${codexHooks.installed} installed`)} in ${accent(codexHooks.hooksFile)}`);
    console.log(warning('Open Codex and run `/hooks` once to review and trust the new hooks.'));
  } else if (detectedCodexForSetup(detections, toolProviders)) {
    console.log(warning('Codex hooks skipped by --no-codex-hooks.'));
  } else {
    console.log(dim('Codex hooks skipped because Codex was not detected.'));
  }
  if (claudeHooks) {
    console.log(`${chalk.bold('Claude hooks:')} ${success(`${claudeHooks.installed} installed`)} in ${accent(claudeHooks.settingsFile)}`);
  } else if (detectedClaudeForSetup(detections, toolProviders)) {
    console.log(warning('Claude hooks skipped by --no-claude-hooks.'));
  } else {
    console.log(dim('Claude hooks skipped because Claude Code was not detected.'));
  }
  if (!startNow) {
    console.log(dim('Startup is installed; daemon will run at next login.'));
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

function formatWindowMinutes(minutes: number | null | undefined): string {
  if (!minutes || !Number.isFinite(minutes)) {
    return 'window';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)}h`;
  }

  if (minutes === 10080) {
    return 'weekly';
  }

  return `${Math.round(minutes / 1440)}d`;
}

function formatUsageWindow(label: string, window: unknown): string | null {
  if (!window || typeof window !== 'object') {
    return null;
  }

  const data = window as {
    usedPercent?: unknown;
    windowMinutes?: unknown;
    resetDescription?: unknown;
  };

  if (typeof data.usedPercent !== 'number') {
    return null;
  }

  const windowLabel = label || formatWindowMinutes(
    typeof data.windowMinutes === 'number' ? data.windowMinutes : null
  );
  const remainingPercent = Math.max(0, Math.min(100, 100 - data.usedPercent));

  return `${windowLabel} ${Math.round(remainingPercent)}%`;
}

function extractNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolFamilyForTool(tool: ActiveTool | null | undefined): ToolFamily {
  if (!tool) {
    return 'other';
  }

  if (tool.family) {
    return tool.family;
  }

  const text = [tool.key, tool.details, tool.state]
    .join(' ')
    .toLowerCase();

  if (text.includes('claude')) {
    return 'claude';
  }

  if (text.includes('codex')) {
    return 'codex';
  }

  return 'other';
}

function clientIdForTool(tool: ActiveTool): string | null {
  const application = discordApplicationForTool(tool, toolProviders, DISCORD_APPLICATIONS);
  return application?.clientId || FALLBACK_CLIENT_ID || null;
}

function isCodexTool(tool: ActiveTool | null | undefined): boolean {
  return toolFamilyForTool(tool) === 'codex';
}

function codexUsageUrl(pathname: string): string {
  return `${CODEX_API_BASE_URL}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function formatCodexPlanText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return titleCase(value
    .replace(/^chatgpt[_-]/i, '')
    .replace(/\s*\(\$[^)]*\)/g, '')
    .replace(/[_-]+/g, ' '))
    .replace(/\bX(\d)/g, 'x$1');
}

function formatCodexMultiplierText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return `x${Number.isInteger(value) ? value : value.toFixed(1)}`;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const text = value.trim();
  const match = text.match(/(?:^|[\s_-])x?(\d+(?:\.\d+)?)(?:x)?(?:$|[\s_-])/i);
  if (!match) {
    return null;
  }

  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 1) {
    return null;
  }

  return `x${Number.isInteger(number) ? number : number.toFixed(1)}`;
}

function extractCodexPlanText(...records: Array<Record<string, unknown> | null | undefined>): string | null {
  const planKeys = [
    'planText',
    'plan_text',
    'planName',
    'plan_name',
    'plan',
    'planType',
    'plan_type',
    'chatgptPlanType',
    'chatgpt_plan_type',
    'subscriptionPlan',
    'subscription_plan',
    'subscriptionTier',
    'subscription_tier',
    'rateLimitTier',
    'rate_limit_tier',
    'usageTier',
    'usage_tier',
    'tier'
  ];
  const multiplierKeys = [
    'multiplier',
    'quotaMultiplier',
    'quota_multiplier',
    'rateLimitMultiplier',
    'rate_limit_multiplier',
    'usageMultiplier',
    'usage_multiplier',
    'codexMultiplier',
    'codex_multiplier'
  ];
  let planText: string | null = null;
  let multiplierText: string | null = null;

  for (const record of records) {
    if (!record) {
      continue;
    }

    if (!planText) {
      for (const key of planKeys) {
        planText = formatCodexPlanText(extractString(record[key]));
        if (planText) {
          break;
        }
      }
    }

    if (!multiplierText) {
      for (const key of multiplierKeys) {
        multiplierText = formatCodexMultiplierText(record[key]);
        if (multiplierText) {
          break;
        }
      }
    }
  }

  if (planText && multiplierText && !planText.toLowerCase().includes(multiplierText.toLowerCase())) {
    return `${planText} ${multiplierText}`;
  }

  return planText || multiplierText;
}

function formatCodexCredits(value: number | null): string | null {
  if (value === null) {
    return null;
  }

  return `credits ${value.toFixed(value % 1 === 0 ? 0 : 1)}`;
}

function codexQuotaWindowFromRecord(value: unknown): CodexQuotaWindow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const usedPercent = extractNumberLike(record.usedPercent ?? record.used_percent);
  if (usedPercent === null) {
    return null;
  }

  const explicitMinutes = extractNumberLike(
    record.windowMinutes
      ?? record.window_duration_mins
      ?? record.windowDurationMins
  );
  const seconds = extractNumberLike(
    record.limit_window_seconds
      ?? record.limitWindowSeconds
  );
  const windowMinutes = explicitMinutes !== null
    ? explicitMinutes
    : (seconds === null ? null : seconds / 60);

  return {
    usedPercent,
    windowMinutes
  };
}

function codexQuotaFromRpcResult(result: unknown): CodexQuotaSnapshot | null {
  const payload = asRecord(result);
  const rateLimits = asRecord(payload?.rateLimits ?? payload?.rate_limits) || payload;
  if (!rateLimits) {
    return null;
  }

  const credits = asRecord(rateLimits.credits);
  const planText = extractCodexPlanText(payload, rateLimits, credits);
  const primary = codexQuotaWindowFromRecord(rateLimits.primary ?? rateLimits.primary_window);
  const secondary = codexQuotaWindowFromRecord(rateLimits.secondary ?? rateLimits.secondary_window);
  const creditsRemaining = extractNumberLike(credits?.balance);

  if (!planText && !primary && !secondary && creditsRemaining === null) {
    return null;
  }

  return {
    source: 'codex-rpc',
    planText,
    primary,
    secondary,
    creditsRemaining
  };
}

function codexQuotaFromUsageResponse(payload: unknown): CodexQuotaSnapshot | null {
  const response = asRecord(payload);
  if (!response) {
    return null;
  }

  const rateLimit = asRecord(response.rate_limit ?? response.rateLimit) || response;
  const credits = asRecord(response.credits);
  const planText = extractCodexPlanText(response, rateLimit, credits);
  const primary = codexQuotaWindowFromRecord(rateLimit.primary_window ?? rateLimit.primary);
  const secondary = codexQuotaWindowFromRecord(rateLimit.secondary_window ?? rateLimit.secondary);
  const creditsRemaining = extractNumberLike(credits?.balance);

  if (!planText && !primary && !secondary && creditsRemaining === null) {
    return null;
  }

  return {
    source: 'codex-oauth',
    planText,
    primary,
    secondary,
    creditsRemaining
  };
}

function formatCodexQuotaText(snapshot: CodexQuotaSnapshot): string | null {
  return formatRichStateText(richStateFromCodexSnapshot(snapshot));
}

function formatRichStateText(parts: RichStateParts): string | null {
  const text = joinMetricParts([
    parts.planText,
    parts.limitsText
  ]);

  return text || null;
}

function richStateFromCodexSnapshot(snapshot: CodexQuotaSnapshot, tool?: ActiveTool): RichStateParts {
  const windowTexts = [snapshot.primary, snapshot.secondary]
    .filter((window): window is CodexQuotaWindow => window !== null)
    .sort((left, right) => (left.windowMinutes ?? Number.POSITIVE_INFINITY)
      - (right.windowMinutes ?? Number.POSITIVE_INFINITY))
    .map((window) => formatUsageWindow('', window))
    .filter((text): text is string => text !== null);
  const limitsText = LIMITS_TEXT_OVERRIDE || joinMetricParts([
    ...windowTexts,
    windowTexts.length === 0 ? formatCodexCredits(snapshot.creditsRemaining) : null
  ]);

  return {
    planText: PLAN_TEXT_OVERRIDE || snapshot.planText,
    limitsText
  };
}

function richStateFromRecord(record: Record<string, unknown>, tool?: ActiveTool): RichStateParts {
  const plan = extractString(record.planText ?? record.plan_text ?? record.plan ?? record.planName ?? record.plan_name ?? record.planType ?? record.plan_type);
  const limits = extractString(record.limitsText ?? record.limits_text ?? record.limits ?? record.quota ?? record.quotaText ?? record.quota_text);

  return {
    planText: PLAN_TEXT_OVERRIDE || formatCodexPlanText(plan) || plan,
    limitsText: LIMITS_TEXT_OVERRIDE || (limits ? truncatePresenceText(limits) : null)
  };
}

function parseRichStateCommandOutput(output: string, tool?: ActiveTool): string | null {
  const text = output.trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    if (record) {
      return formatRichStateText(richStateFromRecord(record, tool));
    }
  } catch (_) {
    // Plain text command output is still supported.
  }

  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine ? truncatePresenceText(firstLine) : null;
}

function createHttpStatusError(status: number, url: string): Error & { status?: number } {
  const error = new Error(`HTTP ${status} from ${url}`) as Error & { status?: number };
  error.status = status;
  return error;
}

async function fetchCodexJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });

    if (!response.ok) {
      throw createHttpStatusError(response.status, url);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function readCodexOAuthCredentials(): CodexOAuthCredentials | null {
  if (!fs.existsSync(CODEX_AUTH_FILE)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf8')) as Record<string, unknown>;
    const tokens = asRecord(parsed.tokens) || parsed;
    const accessToken = extractString(tokens.access_token ?? tokens.accessToken);
    const refreshToken = extractString(tokens.refresh_token ?? tokens.refreshToken);
    const accountId = extractString(
      tokens.account_id
        ?? tokens.accountId
        ?? parsed.account_id
        ?? parsed.accountId
    );

    if (!accessToken && !refreshToken) {
      return null;
    }

    return {
      accessToken,
      refreshToken,
      accountId
    };
  } catch (error) {
    logError('Failed to read Codex auth file', error);
    return null;
  }
}

async function refreshCodexAccessToken(refreshToken: string): Promise<string | null> {
  if (!CODEX_OAUTH_CLIENT_ID) {
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
    scope: 'openid profile email'
  });

  const payload = await fetchCodexJson('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body
  });
  const record = asRecord(payload);

  return extractString(record?.access_token ?? record?.accessToken);
}

async function fetchCodexOAuthUsage(accessToken: string, accountId: string | null): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': APP_ID
  };

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  return fetchCodexJson(codexUsageUrl('/wham/usage'), {
    method: 'GET',
    headers
  });
}

async function fetchCodexOAuthQuota(): Promise<CodexQuotaSnapshot | null> {
  const credentials = readCodexOAuthCredentials();
  if (!credentials) {
    return null;
  }

  let accessToken = credentials.accessToken;
  if (!accessToken && credentials.refreshToken) {
    accessToken = await refreshCodexAccessToken(credentials.refreshToken);
  }

  if (!accessToken) {
    return null;
  }

  try {
    return codexQuotaFromUsageResponse(await fetchCodexOAuthUsage(accessToken, credentials.accountId));
  } catch (error) {
    if ((error as { status?: number }).status !== 401 || !credentials.refreshToken) {
      throw error;
    }

    const refreshedToken = await refreshCodexAccessToken(credentials.refreshToken);
    if (!refreshedToken) {
      throw error;
    }

    return codexQuotaFromUsageResponse(await fetchCodexOAuthUsage(refreshedToken, credentials.accountId));
  }
}

async function fetchCodexRpcQuota(): Promise<CodexQuotaSnapshot | null> {
  const child = spawn(CODEX_BIN, ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map<number, PendingJsonRpcRequest>();
  let nextId = 1;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let closed = false;

  function rejectAll(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }

    pending.clear();
  }

  function sendPayload(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function sendServerError(id: number, message: string): void {
    sendPayload({
      id,
      error: {
        code: -32000,
        message
      }
    });
  }

  async function handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (method !== 'account/chatgptAuthTokens/refresh') {
      sendServerError(id, `Unsupported server request: ${method}`);
      return;
    }

    const credentials = readCodexOAuthCredentials();
    const requestParams = asRecord(params);
    const accountId = credentials?.accountId
      || extractString(requestParams?.previousAccountId)
      || null;

    if (!credentials || !credentials.refreshToken || !accountId) {
      sendServerError(id, 'Codex auth refresh credentials are unavailable');
      return;
    }

    const accessToken = await refreshCodexAccessToken(credentials.refreshToken);
    if (!accessToken) {
      sendServerError(id, 'Codex auth refresh returned no access token');
      return;
    }

    sendPayload({
      id,
      result: {
        accessToken,
        chatgptAccountId: accountId,
        chatgptPlanType: null
      }
    });
  }

  function request(method: string, params: Record<string, unknown> = {}, timeoutMs = Math.min(USAGE_TIMEOUT_MS, 8_000)): Promise<Record<string, unknown>> {
    if (closed) {
      return Promise.reject(new Error('Codex RPC process is closed'));
    }

    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex RPC timed out on ${method}`));
      }, timeoutMs);

      pending.set(id, {
        method,
        timeout,
        resolve,
        reject
      });

      try {
        sendPayload({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function handleMessage(message: Record<string, unknown>): void {
    const id = extractNumberLike(message.id);
    if (id === null) {
      return;
    }

    const method = extractString(message.method);
    if (method && message.result === undefined && message.error === undefined) {
      void handleServerRequest(id, method, message.params).catch((error) => {
        try {
          sendServerError(id, error instanceof Error ? error.message : String(error));
        } catch (_) {
          // The child may have already exited.
        }
      });
      return;
    }

    const pendingRequest = pending.get(id);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    pending.delete(id);

    const error = asRecord(message.error);
    if (error) {
      pendingRequest.reject(new Error(extractString(error.message) || `${pendingRequest.method} failed`));
      return;
    }

    pendingRequest.resolve(message);
  }

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line);
        if (message && typeof message === 'object') {
          handleMessage(message as Record<string, unknown>);
        }
      } catch (_) {
        // app-server stdout is expected to be JSON only; ignore stray lines defensively.
      }
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuffer = `${stderrBuffer}${chunk.toString('utf8')}`.slice(-2_000);
  });

  child.on('error', (error: Error) => {
    closed = true;
    rejectAll(error);
  });

  child.on('close', () => {
    closed = true;
    if (pending.size) {
      const detail = stderrBuffer.trim();
      rejectAll(new Error(detail ? `Codex RPC closed: ${detail}` : 'Codex RPC closed'));
    }
  });

  try {
    await request('initialize', {
      clientInfo: {
        name: APP_ID,
        version: VERSION
      }
    });
    sendPayload({ method: 'initialized', params: {} });

    const response = await request('account/rateLimits/read');
    return codexQuotaFromRpcResult(response.result);
  } finally {
    try {
      child.stdin.end();
    } catch (_) {
      // The process may have already closed stdin.
    }

    if (!closed) {
      child.kill('SIGTERM');
    }
  }
}

async function getNativeCodexQuotaText(
  tool?: ActiveTool,
  quotaSource: CodexQuotaSource = CODEX_QUOTA_SOURCE
): Promise<string | null> {
  if (quotaSource === 'off' || !isCodexTool(tool)) {
    return null;
  }

  const sources: Array<Exclude<CodexQuotaSource, 'off' | 'auto'>> = quotaSource === 'auto'
    ? ['oauth', 'rpc']
    : [quotaSource];

  for (const source of sources) {
    try {
      const snapshot = source === 'rpc'
        ? await fetchCodexRpcQuota()
        : await fetchCodexOAuthQuota();
      const text = snapshot ? formatCodexQuotaText(snapshot) : null;

      if (text) {
        return text;
      }
    } catch (error) {
      logError(`Codex ${source} quota fetch failed`, error);
    }
  }

  return null;
}

async function getNativeCodexRichState(
  tool?: ActiveTool,
  quotaSource: CodexQuotaSource = CODEX_QUOTA_SOURCE
): Promise<RichStateParts | null> {
  if (quotaSource === 'off' || !isCodexTool(tool)) {
    return null;
  }

  const sources: Array<Exclude<CodexQuotaSource, 'off' | 'auto'>> = quotaSource === 'auto'
    ? ['oauth', 'rpc']
    : [quotaSource];

  for (const source of sources) {
    try {
      const snapshot = source === 'rpc'
        ? await fetchCodexRpcQuota()
        : await fetchCodexOAuthQuota();

      if (snapshot) {
        return richStateFromCodexSnapshot(snapshot, tool);
      }
    } catch (error) {
      logError(`Codex ${source} quota fetch failed`, error);
    }
  }

  return null;
}

function parseClaudeCredentialJson(value: string): unknown | null {
  const text = value.trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function readClaudeKeychainCredentials(): Promise<unknown | null> {
  if (
    process.platform !== 'darwin'
    || envValue('DISCORD_CODING_STATUS_CLAUDE_KEYCHAIN', 'on').trim().toLowerCase() === 'off'
  ) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      CLAUDE_KEYCHAIN_SERVICE,
      '-w'
    ], {
      timeout: 2_000,
      maxBuffer: 256 * 1024
    }) as { stdout: string };
    return parseClaudeCredentialJson(stdout);
  } catch (_) {
    return null;
  }
}

async function readClaudeKeychainAccount(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      CLAUDE_KEYCHAIN_SERVICE
    ], {
      timeout: 2_000,
      maxBuffer: 64 * 1024
    }) as { stdout: string };
    const match = stdout.match(/"acct"<blob>="([^"]+)"/);
    return match?.[1] || null;
  } catch (_) {
    return null;
  }
}

async function writeClaudeKeychainCredentials(value: unknown): Promise<void> {
  if (
    process.platform !== 'darwin'
    || envValue('DISCORD_CODING_STATUS_CLAUDE_KEYCHAIN', 'on').trim().toLowerCase() === 'off'
  ) {
    throw new Error('Claude Code Keychain credentials are available only on macOS.');
  }

  const account = await readClaudeKeychainAccount() || os.userInfo().username;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('security', [
      'add-generic-password',
      '-U',
      '-a',
      account,
      '-s',
      CLAUDE_KEYCHAIN_SERVICE,
      '-w'
    ], {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out while updating Claude Code Keychain credentials.'));
    }, 2_000);

    child.once('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error('Failed to update Claude Code Keychain credentials.'));
      }
    });
    child.stdin.end(`${JSON.stringify(value)}\n`);
  });
}

async function readClaudeFileCredentials(): Promise<unknown | null> {
  if (!fs.existsSync(CLAUDE_CREDENTIALS_FILE)) {
    return null;
  }

  try {
    return parseClaudeCredentialJson(fs.readFileSync(CLAUDE_CREDENTIALS_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function writeClaudeFileCredentials(value: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(CLAUDE_CREDENTIALS_FILE), { recursive: true });
  const tempFile = `${CLAUDE_CREDENTIALS_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, CLAUDE_CREDENTIALS_FILE);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {
      // The successful rename already removed the temporary pathname.
    }
  }
}

const claudeCredentialStore = createClaudeCredentialStore({
  keychain: {
    read: readClaudeKeychainCredentials,
    write: writeClaudeKeychainCredentials,
    async compareAndSwap(expectedGeneration, update) {
      const current = await readClaudeKeychainCredentials();
      if (claudeCredentialGeneration(current) !== expectedGeneration) {
        return false;
      }
      const latest = await readClaudeKeychainCredentials();
      if (claudeCredentialGeneration(latest) !== expectedGeneration) {
        return false;
      }
      await writeClaudeKeychainCredentials(update(latest));
      return true;
    }
  },
  file: {
    read: readClaudeFileCredentials,
    write: writeClaudeFileCredentials,
    async compareAndSwap(expectedGeneration, update) {
      const current = await readClaudeFileCredentials();
      if (claudeCredentialGeneration(current) !== expectedGeneration) {
        return false;
      }
      const latest = await readClaudeFileCredentials();
      if (claudeCredentialGeneration(latest) !== expectedGeneration) {
        return false;
      }
      await writeClaudeFileCredentials(update(latest));
      return true;
    }
  }
});
const claudeQuotaEngine = new ClaudeQuotaEngine({
  credentials: claudeCredentialStore,
  http: createFetchClaudeHttpClient(),
  userAgent: `claude-code/${VERSION} (${APP_ID})`
});
let lastClaudeQuotaDiagnostic: string | null = null;

function recordClaudeQuotaDiagnostic(message: string | null): void {
  if (!message || message === lastClaudeQuotaDiagnostic) {
    return;
  }

  lastClaudeQuotaDiagnostic = message;
  log(`[claude-quota] ${message}`);
}

async function getNativeClaudeQuotaText(tool?: ActiveTool): Promise<string | null> {
  if (tool && toolFamilyForTool(tool) !== 'claude') {
    return null;
  }

  if (tool && tool.claudeQuotaEligible !== true) {
    recordClaudeQuotaDiagnostic('Claude quota is hidden because the active session is not confirmed as subscription OAuth.');
    return null;
  }

  const result = await claudeQuotaEngine.getQuota(claudeQuotaRequestOptions());
  recordClaudeQuotaDiagnostic(result.diagnostic);
  if (result.status === 'unavailable') {
    return null;
  }

  lastClaudeQuotaDiagnostic = null;
  return result.quota.text;
}

function log(message: string): void {
  console.log(`${dim(`[${APP_ID}]`)} ${dim(new Date().toISOString())} ${message}`);
}

function debugLog(message: string): void {
  if (DEBUG_ENABLED) {
    log(`[debug] ${message}`);
  }
}

function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : String(error || '');
  console.error(`${dim(`[${APP_ID}]`)} ${dim(new Date().toISOString())} ${danger(message)}${detail ? `: ${detail}` : ''}`);
}

function validateEnvironment(): void {
  const ids = [
    ...[...DISCORD_APPLICATIONS.values()].map(
      (application) => [application.clientIdEnvironment, application.clientId] as const
    ),
    ['DISCORD_CLIENT_ID', FALLBACK_CLIENT_ID] as const
  ];

  for (const [name, value] of ids) {
    if (!value) {
      if (name === 'DISCORD_CLIENT_ID') {
        continue;
      }

      console.error(danger(`Missing ${name}.`));
      process.exit(1);
    }

    if (!/^\d{10,32}$/.test(value)) {
      console.error(danger(`${name} does not look like a Discord Application ID.`));
      console.error(dim('Expected a numeric client ID, not a bot token, client secret, or application name.'));
      process.exit(1);
    }
  }
}

function createRpcConnectionState(): RpcConnectionState {
  return {
    client: null,
    ready: false,
    reconnectTimer: null,
    connecting: null,
    activeToolKey: null,
    activityStartedAt: null,
    lastSentActivitySignature: null,
    lastCleared: true,
    connectionAttempt: 0
  };
}

function rpcStateForClientId(clientId: string): RpcConnectionState {
  let state = rpcConnections.get(clientId);
  if (!state) {
    state = createRpcConnectionState();
    rpcConnections.set(clientId, state);
  }

  return state;
}

function labelForClientId(clientId: string): string {
  return [...DISCORD_APPLICATIONS.values()].find(
    (application) => application.clientId === clientId
  )?.label || clientId;
}

function cancelReconnect(state: RpcConnectionState): void {
  if (!state.reconnectTimer) {
    return;
  }

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function scheduleReconnect(clientId: string): void {
  const state = rpcStateForClientId(clientId);
  if (shuttingDown || state.reconnectTimer) {
    return;
  }

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectToDiscord(clientId);
  }, RECONNECT_INTERVAL_MS);
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

async function connectToDiscord(clientId: string): Promise<void> {
  const state = rpcStateForClientId(clientId);

  if (shuttingDown || state.ready) {
    return;
  }

  if (state.connecting) {
    return state.connecting;
  }

  state.connecting = (async () => {
    const attemptId = ++state.connectionAttempt;
    let client: any | null = null;

    try {
      if (state.client) {
        try {
          state.client.destroy();
        } catch (_) {
          // Best effort cleanup before creating a fresh IPC client.
        }
      }

      DiscordRPC.register(clientId);
      client = new DiscordRPC.Client({ transport: 'ipc' });
      state.client = client;

      client.on('ready', () => {
        if (attemptId !== state.connectionAttempt || client !== state.client) {
          return;
        }

        state.ready = true;
        log(`Connected to Discord Desktop RPC for ${labelForClientId(clientId)}.`);
        runLoopOnce();
      });

      client.on('disconnected', () => {
        if (!shuttingDown && attemptId === state.connectionAttempt && client === state.client) {
          state.ready = false;
          state.lastSentActivitySignature = null;
          state.lastCleared = false;
          log(`Discord RPC disconnected for ${labelForClientId(clientId)}. Will retry.`);
          scheduleReconnect(clientId);
        }
      });

      client.on('error', (error: unknown) => {
        if (!shuttingDown && attemptId === state.connectionAttempt && client === state.client) {
          logError(`Discord RPC error for ${labelForClientId(clientId)}`, error);
        }
      });

      log(`Connecting to Discord Desktop RPC for ${labelForClientId(clientId)}...`);
      const loginPromise = client.login({ clientId });
      loginPromise.catch(() => {});
      await Promise.race([
        loginPromise,
        rejectAfter(CONNECT_TIMEOUT_MS, 'Timed out while waiting for Discord RPC.')
      ]);
    } catch (error) {
      if (client && client === state.client) {
        try {
          client.destroy();
        } catch (_) {
          // Best effort cleanup before retrying.
        }

        state.client = null;
      }

      state.ready = false;
      logError(`Could not connect to Discord RPC for ${labelForClientId(clientId)}. Is Discord Desktop running?`, error);
      scheduleReconnect(clientId);
    } finally {
      if (state.connecting) {
        state.connecting = null;
      }
    }
  })();

  return state.connecting;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function surfaceLabel(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'cli') {
    return 'CLI';
  }

  if (normalized === 'app') {
    return 'App';
  }

  return titleCase(normalized || 'Session');
}

function statePriority(status: string): number {
  const normalized = normalizeStatus(status);

  if (normalized === 'waiting_approval') {
    return 100;
  }

  if (['running', 'thinking', 'streaming', 'active'].includes(normalized)) {
    return 80;
  }

  if (['waiting_input', 'waiting'].includes(normalized)) {
    return 60;
  }

  if (['idle', 'paused'].includes(normalized)) {
    return 20;
  }

  return 40;
}

function sessionDetails(activity: string | undefined, fallback: string): string {
  return DETAIL_LEVEL === 'full' && activity ? activity : fallback;
}

function toolFromSession(session: HookSessionState): ActiveTool {
  const tool = session.tool.trim().toLowerCase();
  const surface = session.surface.trim().toLowerCase();
  const status = statusLabel(session.status);
  const surfaceText = surfaceLabel(surface);
  const provider = findToolProviderByAlias(tool, surface, toolProviders);

  if (tool === 'claude' || tool === 'claude-code') {
    return {
      key: `state:${session.session_id}`,
      providerId: provider?.id || 'claudeCode',
      family: 'claude',
      details: sessionDetails(session.activity, 'Using Claude Code'),
      state: joinPresenceParts(['Claude Code', surfaceText, status]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      updatedAt: session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null,
      claudeQuotaEligible: session.claude_quota_eligible ?? null
    };
  }

  if (tool === 'codex') {
    return {
      key: `state:${session.session_id}`,
      providerId: provider?.id || (surface === 'app' ? 'codexApp' : 'codexCli'),
      family: 'codex',
      details: sessionDetails(session.activity, 'Using Codex'),
      state: joinPresenceParts(['Codex', surfaceText, status]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null
    };
  }

  if (provider?.presence) {
    return {
      key: `state:${session.session_id}`,
      providerId: provider.id,
      family: provider.family,
      details: sessionDetails(session.activity, provider.presence.details),
      state: joinPresenceParts([
        provider.discord?.label || provider.presence.state,
        surfaceText,
        status
      ]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null
    };
  }

  return {
    key: `state:${session.session_id}`,
    family: 'other',
    details: sessionDetails(session.activity, `Using ${titleCase(tool)}`),
    state: joinPresenceParts([surfaceText, status]),
    cwd: session.cwd,
    sessionId: session.session_id,
    startedAt: session.started_at || session.updated_at || null,
    status: session.status,
    activity: session.activity || null,
    model: session.model || null,
    effort: session.effort || null,
    contextText: session.context || null,
    projectName: session.project || null,
    packageName: session.package || null
  };
}

function detectStateTools(): ActiveTool[] {
  const state = cleanupStateSessions(readStateFile(), Date.now());
  const sessions = Object.values(state.sessions);
  const activeClaudeSessionIds = new Set(
    sessions
      .filter((session) => ['claude', 'claude-code'].includes(session.tool.trim().toLowerCase()))
      .map((session) => session.session_id)
  );
  for (const sessionId of claudeUsageRevisionBySession.keys()) {
    if (!activeClaudeSessionIds.has(sessionId)) {
      claudeUsageRevisionBySession.delete(sessionId);
    }
  }

  if (!sessions.length) {
    return [];
  }

  sessions.sort((a, b) => {
    const priorityDelta = statePriority(b.status) - statePriority(a.status);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return b.updated_at - a.updated_at;
  });

  const tools: ActiveTool[] = [];
  const seenFamilies = new Set<string>();

  for (const session of sessions) {
    const tool = toolFromSession(session);
    const family = toolFamilyForTool(tool);
    const key = family === 'other' ? `other:${tool.key}` : family;

    if (seenFamilies.has(key)) {
      continue;
    }

    tools.push(tool);
    seenFamilies.add(key);
  }

  return tools;
}

function detectStateTool(): ActiveTool | null {
  return detectStateTools()[0] || null;
}

function mergeActiveTools(primary: ActiveTool[], fallback: ActiveTool[]): ActiveTool[] {
  const tools: ActiveTool[] = [];
  const seen = new Set<string>();

  for (const tool of [...primary, ...fallback]) {
    const family = toolFamilyForTool(tool);
    const key = family === 'other' ? `other:${tool.key}` : family;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    tools.push(tool);
  }

  return tools;
}

function isLikelyAppInternalPath(directory: string | null | undefined): boolean {
  const normalized = String(directory || '').toLowerCase();

  return (
    !normalized ||
    normalized === '/' ||
    normalized.includes('.app/contents/') ||
    normalized.includes('/applications/codex.app') ||
    normalized.includes('/applications/discord.app')
  );
}

function readPackageInfo(startDirectory: string | null): PackageInfo | null {
  if (!startDirectory || isLikelyAppInternalPath(startDirectory)) {
    return null;
  }

  let current = startDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = path.join(current, 'package.json');

    if (fs.existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        return {
          root: current,
          name: typeof packageJson.name === 'string' ? packageJson.name : null
        };
      } catch (_) {
        return {
          root: current,
          name: null
        };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

function getGitBranch(directory: string | null): string | null {
  if (!directory || isLikelyAppInternalPath(directory)) {
    return null;
  }

  try {
    const branch = execFileSyncString('git', ['-C', directory, 'symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    return sanitizeBranchName(branch);
  } catch (_) {
    try {
      const commit = execFileSyncString('git', ['-C', directory, 'rev-parse', '--short', 'HEAD']).trim();
      return commit ? `detached:${commit}` : null;
    } catch (_) {
      return null;
    }
  }
}

async function getUsageText(tool?: ActiveTool): Promise<string | null> {
  if (!shouldShowUsage()) {
    return null;
  }

  const cacheKey = toolFamilyForTool(tool) || 'other';
  const isClaude = cacheKey === 'claude';
  if (isClaude && tool?.claudeQuotaEligible !== true) {
    cachedUsageTextByKey.delete(cacheKey);
    if (tool?.sessionId) {
      claudeUsageRevisionBySession.delete(tool.sessionId);
    }
    return null;
  }

  let cachedUsage = cachedUsageTextByKey.get(cacheKey);
  if (isClaude && tool?.sessionId && tool.updatedAt) {
    const previousRevision = claudeUsageRevisionBySession.get(tool.sessionId);
    if (previousRevision !== tool.updatedAt) {
      claudeUsageRevisionBySession.set(tool.sessionId, tool.updatedAt);
      cachedUsageTextByKey.delete(cacheKey);
      cachedUsage = undefined;
    }
  }

  if (!isClaude && USAGE_TEXT) {
    return truncatePresenceText(USAGE_TEXT);
  }

  const now = Date.now();
  if (cachedUsage && now - cachedUsage.fetchedAt < USAGE_REFRESH_INTERVAL_MS) {
    return cachedUsage.text;
  }

  if (!usageRefreshesByKey.has(cacheKey)) {
    const refresh = refreshUsageText(tool, cacheKey)
      .catch((error) => {
        logError(`Usage refresh failed for ${cacheKey}`, error);
        cachedUsageTextByKey.set(cacheKey, {
          text: isClaude ? null : cachedUsage?.text || null,
          fetchedAt: Date.now()
        });
      })
      .finally(() => {
        usageRefreshesByKey.delete(cacheKey);

        if (!shuttingDown) {
          void runLoopOnce();
        }
      });
    usageRefreshesByKey.set(cacheKey, refresh);
  }

  return cachedUsage?.text || (isClaude ? null : PLAN_TEXT_OVERRIDE || null);
}

async function refreshUsageText(tool: ActiveTool | undefined, cacheKey: string): Promise<void> {
  const cachedUsage = cachedUsageTextByKey.get(cacheKey);
  let text: string | null = null;

  const toolFamily = toolFamilyForTool(tool);
  if (toolFamily === 'codex') {
    const nativeCodexRichState = await getNativeCodexRichState(tool);
    const nativeCodexQuotaText = nativeCodexRichState ? formatRichStateText(nativeCodexRichState) : null;
    if (nativeCodexQuotaText) {
      text = nativeCodexQuotaText;
    }
  } else if (toolFamily === 'claude') {
    text = await getNativeClaudeQuotaText(tool);
  }

  if (!text && toolFamily !== 'claude' && PLAN_TEXT_OVERRIDE) {
    text = PLAN_TEXT_OVERRIDE;
  } else if (!text && toolFamily !== 'claude' && USAGE_COMMAND) {
    try {
      const { stdout } = await execAsync(USAGE_COMMAND, {
        timeout: USAGE_TIMEOUT_MS,
        maxBuffer: 16 * 1024
      }) as { stdout: string };

      text = parseRichStateCommandOutput(stdout, tool);
    } catch (error) {
      logError('Usage command failed', error);
      text = cachedUsage?.text || null;
    }
  }

  const nextText = toolFamily === 'claude'
    ? text
    : text || cachedUsage?.text || null;
  cachedUsageTextByKey.set(cacheKey, {
    text: nextText,
    fetchedAt: Date.now()
  });
  debugLog(
    text
      ? `Usage refresh completed for ${cacheKey}: ${text}.`
      : `Usage refresh unavailable for ${cacheKey}; retaining ${nextText || 'no cached value'}.`
  );
}

async function getPresenceMetadata(tool: ActiveTool): Promise<PresenceMetadata> {
  const metadata: PresenceMetadata = {
    projectName: null,
    packageName: null,
    branchName: null,
    usageText: null
  };

  if (!shouldShowProject() && !shouldShowPackage() && !shouldShowUsage()) {
    return metadata;
  }

  const cwd = tool.cwd || await getCwdForProcess(tool.processInfo);
  const packageInfo = readPackageInfo(cwd);
  const projectRoot = packageInfo?.root || cwd;

  if (shouldShowProject()) {
    metadata.projectName = sanitizeProjectName(PROJECT_NAME_OVERRIDE)
      || sanitizeProjectName(tool.projectName)
      || sanitizeProjectName(packageInfo && packageInfo.root)
      || sanitizeProjectName(cwd);
  }

  metadata.branchName = getGitBranch(projectRoot);

  if (shouldShowPackage()) {
    metadata.packageName = sanitizePackageName(PACKAGE_NAME_OVERRIDE)
      || sanitizePackageName(tool.packageName)
      || sanitizePackageName(packageInfo && packageInfo.name);
  }

  metadata.usageText = await getUsageText(tool);
  return metadata;
}

function activityTextForPresence(tool: ActiveTool): string {
  return truncatePresenceText(
    tool.activity
      || styledStatusLabel(tool.status)
      || tool.details
      || tool.state
  );
}

function projectBranchText(metadata: PresenceMetadata): string | null {
  if (metadata.projectName && metadata.branchName) {
    return `${metadata.projectName} @ ${metadata.branchName}`;
  }

  return metadata.projectName;
}

function modelTextForPresence(tool: ActiveTool): string | null {
  const model = String(tool.model || '').replace(/\s+/g, ' ').trim();
  const effort = String(tool.effort || '').replace(/\s+/g, ' ').trim();

  if (!model) {
    return null;
  }

  return truncatePresenceText(effort ? `${model} · ${effort}` : model);
}

async function enrichToolForPresence(tool: ActiveTool | null): Promise<ActiveTool | null> {
  if (!tool) {
    return null;
  }

  const metadata = await getPresenceMetadata(tool);
  const activityText = activityTextForPresence(tool);
  const modelText = modelTextForPresence(tool);
  const contextText = formatContextText(tool.contextText);
  const details = joinPresenceParts([
    SHOW_ACTIVITY ? activityText : null,
    SHOW_PROJECT ? projectBranchText(metadata) : null
  ]);
  const quotaFallback = toolFamilyForTool(tool) === 'codex'
    ? PLAN_TEXT_OVERRIDE || (CODEX_QUOTA_SOURCE === 'off' ? 'Codex quota disabled' : 'Codex quota unavailable')
    : null;
  const state = joinPresenceParts([
    SHOW_MODEL ? modelText : null,
    SHOW_QUOTA ? metadata.usageText || quotaFallback : null,
    SHOW_CONTEXT ? contextText : null,
    SHOW_PACKAGE && metadata.packageName ? `pkg ${metadata.packageName}` : null
  ]);

  return {
    ...tool,
    details,
    state
  };
}

async function enrichToolsForPresence(tools: ActiveTool[]): Promise<ActiveTool[]> {
  const enriched = await Promise.all(tools.map((tool) => enrichToolForPresence(tool)));
  return enriched.filter((tool): tool is ActiveTool => Boolean(tool));
}

function buildPresence(tool: ActiveTool, activityStartedAt: Date | null): PresencePayload {
  const presence: PresencePayload = {
    startTimestamp: activityStartedAt || new Date(),
    instance: false
  };
  const largeImageKey = largeImageKeyForTool(tool);

  if (tool.details) {
    presence.details = tool.details;
  }

  if (tool.state) {
    presence.state = tool.state;
  }

  if (largeImageKey) {
    presence.largeImageKey = largeImageKey;
  }

  if (SMALL_IMAGE_KEY) {
    presence.smallImageKey = SMALL_IMAGE_KEY;
  }

  return presence;
}

function largeImageKeyForTool(tool: ActiveTool): string | null {
  const application = discordApplicationForTool(tool, toolProviders, DISCORD_APPLICATIONS);
  return application?.imageKey || LARGE_IMAGE_KEY || null;
}

function activityStartDate(tool: ActiveTool): Date {
  const startedAt = coerceStateTimestamp(tool.startedAt);
  if (!startedAt) {
    return new Date();
  }

  const date = new Date(startedAt);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function getActivitySignature(tool: ActiveTool, activityStartedAt: Date | null): string {
  return [
    clientIdForTool(tool),
    tool.key,
    tool.details,
    tool.state,
    activityStartedAt,
    largeImageKeyForTool(tool),
    SMALL_IMAGE_KEY
  ].join('|');
}

async function clearConnectionActivity(clientId: string, state: RpcConnectionState): Promise<void> {
  state.activeToolKey = null;
  state.activityStartedAt = null;
  state.lastSentActivitySignature = null;
  cancelReconnect(state);

  if (!state.ready || !state.client) {
    state.lastCleared = true;
    return;
  }

  if (!state.lastCleared) {
    await state.client.clearActivity();
    state.lastCleared = true;
    log(`Cleared Discord activity for ${labelForClientId(clientId)}.`);
  }
}

async function updateActivityForClient(clientId: string, tool: ActiveTool): Promise<void> {
  const state = rpcStateForClientId(clientId);

  if (state.activeToolKey !== tool.key) {
    state.activeToolKey = tool.key;
    state.activityStartedAt = activityStartDate(tool);
    state.lastSentActivitySignature = null;
    state.lastCleared = false;
    log(`Detected ${tool.state} for ${labelForClientId(clientId)}.`);
  } else if (!state.activityStartedAt) {
    state.activityStartedAt = activityStartDate(tool);
    state.lastSentActivitySignature = null;
  }

  if (!state.ready || !state.client) {
    await connectToDiscord(clientId);
  }

  if (!state.ready || !state.client) {
    return;
  }

  const signature = getActivitySignature(tool, state.activityStartedAt);
  if (signature === state.lastSentActivitySignature) {
    return;
  }

  await state.client.setActivity(buildPresence(tool, state.activityStartedAt));
  state.lastSentActivitySignature = signature;
  state.lastCleared = false;
  log(`Updated ${labelForClientId(clientId)} activity: ${tool.details} / ${tool.state}.`);
}

async function updateActivities(tools: ActiveTool[]): Promise<void> {
  const activeByClientId = new Map<string, ActiveTool>();

  for (const tool of tools) {
    const clientId = clientIdForTool(tool);
    if (!clientId || activeByClientId.has(clientId)) {
      continue;
    }

    activeByClientId.set(clientId, tool);
  }

  for (const [clientId, state] of rpcConnections) {
    if (!activeByClientId.has(clientId)) {
      await clearConnectionActivity(clientId, state);
    }
  }

  for (const [clientId, tool] of activeByClientId) {
    await updateActivityForClient(clientId, tool);
  }
}

async function updateActivity(tool: ActiveTool | null): Promise<void> {
  await updateActivities(tool ? [tool] : []);
}

let loopInFlight = false;
let loopQueued = false;

async function runLoopOnce(): Promise<void> {
  if (loopInFlight) {
    loopQueued = true;
    return;
  }

  loopInFlight = true;

  try {
    do {
      loopQueued = false;

      try {
        const stateTools = detectStateTools();
        const processTools = PROCESS_DETECTION_ENABLED
          ? detectActiveTools(await getProcessList(), toolProviders, {
            preferredSurfaceByFamily: PREFER_CODEX_CLI ? { codex: 'cli' } : {}
          })
          : [];
        debugLog(`Loop found ${stateTools.length} state tool(s) and ${processTools.length} process tool(s).`);
        const activeTools = await enrichToolsForPresence(
          mergeActiveTools(stateTools, processTools)
        );
        await updateActivities(activeTools);
      } catch (error) {
        logError('Loop iteration failed; continuing', error);
      }
    } while (loopQueued && !shuttingDown);
  } finally {
    loopInFlight = false;
  }
}

function stopStateWatcher(): void {
  if (stateWatchTimer) {
    clearTimeout(stateWatchTimer);
    stateWatchTimer = null;
  }

  if (stateWatcher) {
    stateWatcher.close();
    stateWatcher = null;
  }
}

function startStateWatcher(): void {
  if (stateWatcher) {
    return;
  }

  const stateDirectory = path.dirname(STATE_FILE);
  const stateFilename = path.basename(STATE_FILE);
  fs.mkdirSync(stateDirectory, { recursive: true });

  try {
    const watcher = fs.watch(
      stateDirectory,
      (_eventType: string, filename: string | Buffer | null) => {
        if (shuttingDown || (filename && filename.toString() !== stateFilename)) {
          return;
        }

        if (stateWatchTimer) {
          clearTimeout(stateWatchTimer);
        }

        stateWatchTimer = setTimeout(() => {
          stateWatchTimer = null;
          void runLoopOnce();
        }, STATE_WATCH_DEBOUNCE_MS);
      }
    );
    stateWatcher = watcher;
    log(`Watching ${STATE_FILE} for hook updates.`);

    watcher.on('error', (error: unknown) => {
      logError('State file watcher failed; polling will continue', error);
      stopStateWatcher();
    });
  } catch (error) {
    logError('Could not watch the state file; polling will continue', error);
    stopStateWatcher();
  }
}

function startPolling(): void {
  if (pollTimer) {
    return;
  }

  startStateWatcher();
  pollTimer = setInterval(runLoopOnce, POLL_INTERVAL_MS);
  void runLoopOnce();
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log(`Received ${signal}. Shutting down.`);

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopStateWatcher();

  for (const state of rpcConnections.values()) {
    cancelReconnect(state);
  }

  for (const [clientId, state] of rpcConnections) {
    try {
      if (state.ready && state.client) {
        await state.client.clearActivity();
        log(`Cleared Discord activity for ${labelForClientId(clientId)}.`);
      }
    } catch (error) {
      logError(`Failed to clear ${labelForClientId(clientId)} activity during shutdown`, error);
    }
  }

  for (const state of rpcConnections.values()) {
    try {
      if (state.client) {
        state.client.destroy();
      }
    } catch (_) {
      // Ignore shutdown cleanup errors.
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  logError('Unhandled promise rejection', error);
});
process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
});

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

  validateEnvironment();
  log(`Starting ${APP_TITLE} daemon.`);
  log(`Presence detail level: ${DETAIL_LEVEL}.`);
  startPolling();
}

main().catch((error) => {
  logError('Startup failed', error);
  process.exit(process.exitCode || 1);
});
