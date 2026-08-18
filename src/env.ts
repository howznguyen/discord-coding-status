'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createColors } from 'picocolors';

export const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

import type { ConfigEditorField } from './commands/config/types';
import {
  DEFAULT_ACTIVITY_STYLE,
  DEFAULT_CLAUDE_CONFIG_DIR,
  DEFAULT_CODEX_AUTH_FILE,
  DEFAULT_CODEX_QUOTA_SOURCE,
  DEFAULT_DETAIL_LEVEL,
  createConfigEditorFields
} from './commands/config/schema';
import {
  displaySettingFromEnvironment,
  envPathValue,
  envValue,
  loadEnvironmentFiles,
  normalizeActivityStyle,
  normalizeCodexQuotaSource,
  normalizeDetailLevel,
  parseBoolean,
  resolveHomePath
} from './commands/config/settings';
import { toolProviders } from './providers/registry';
import { resolveDiscordApplications } from './providers/discord';

export const APP_ID = 'discord-coding-status';
export const APP_TITLE = 'Discord Coding Status';
export const APP_AUTHOR = '@howznguyen';
export const APP_WEBSITE = 'https://howznguyen.dev/projects/discord-coding-status';
export const APP_REPOSITORY = 'https://github.com/howznguyen/discord-coding-status';
export const APP_LICENSE = 'MIT';
export const MACOS_LAUNCH_AGENT_ID = 'io.github.discord-coding-status.daemon';
export const WINDOWS_TASK_NAME = 'DiscordCodingStatus';
export const PI_EXTENSION_TARGET = path.join(os.homedir(), '.pi', 'agent', 'extensions', 'discord-coding-status.ts');
export const OPENCODE_PLUGIN_TARGET = path.join(os.homedir(), '.config', 'opencode', 'plugins', 'discord-coding-status.js');
export const USER_DATA_DIR = path.join(os.homedir(), APP_ID);
export const CONFIG_DIR = getConfigDirectory();
export const CONFIG_FILE = path.join(USER_DATA_DIR, 'config.json');
export const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, '.env');
export const DEFAULT_STATE_FILE = path.join(USER_DATA_DIR, 'states.json');
export const CONFIG_EDITOR_FIELDS: ConfigEditorField[] = createConfigEditorFields(DEFAULT_STATE_FILE);
export const CODEX_HOME = resolveHomePath(process.env.CODEX_HOME || '~/.codex');
export const CODEX_HOOKS_FILE = path.join(CODEX_HOME, 'hooks.json');
export const CLAUDE_CONFIG_DIR = resolveHomePath(process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR);
export const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_CONFIG_DIR, 'settings.json');
export const CLAUDE_CREDENTIALS_FILE = path.join(CLAUDE_CONFIG_DIR, '.credentials.json');
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
] as const;

loadEnvironmentFiles(CONFIG_FILE, LEGACY_CONFIG_FILE, process.cwd(), logError);

export const DISCORD_APPLICATIONS = resolveDiscordApplications(toolProviders, envValue);
export const CODEX_CLIENT_ID = DISCORD_APPLICATIONS.get('codex')?.clientId || '';
export const CLAUDE_CLIENT_ID = DISCORD_APPLICATIONS.get('claude')?.clientId || '';
export const OPENCODE_CLIENT_ID = DISCORD_APPLICATIONS.get('opencode')?.clientId || '';
export const PI_CLIENT_ID = DISCORD_APPLICATIONS.get('pi')?.clientId || '';
export const GROK_CLIENT_ID = DISCORD_APPLICATIONS.get('grok')?.clientId || '';
export const FALLBACK_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '').trim();
export const LARGE_IMAGE_KEY = (process.env.DISCORD_LARGE_IMAGE_KEY || '').trim();
export const SMALL_IMAGE_KEY = (process.env.DISCORD_SMALL_IMAGE_KEY || '').trim();
export const DETAIL_LEVEL = normalizeDetailLevel(envValue('DISCORD_CODING_STATUS_DETAIL_LEVEL', DEFAULT_DETAIL_LEVEL));
export const PROJECT_NAME_OVERRIDE = envValue('DISCORD_CODING_STATUS_PROJECT_NAME').trim();
export const PACKAGE_NAME_OVERRIDE = envValue('DISCORD_CODING_STATUS_PACKAGE_NAME').trim();
export const USAGE_TEXT = envValue('DISCORD_CODING_STATUS_USAGE_TEXT').trim();
export const USAGE_COMMAND = envValue('DISCORD_CODING_STATUS_USAGE_COMMAND').trim();
export const CODEX_QUOTA_SOURCE = normalizeCodexQuotaSource(envValue('DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE', DEFAULT_CODEX_QUOTA_SOURCE));
export const CODEX_BIN = envValue('DISCORD_CODING_STATUS_CODEX_BIN', 'codex').trim() || 'codex';
export const CODEX_AUTH_FILE = resolveHomePath(envValue('DISCORD_CODING_STATUS_CODEX_AUTH_FILE', DEFAULT_CODEX_AUTH_FILE));
export const CODEX_API_BASE_URL = envValue('DISCORD_CODING_STATUS_CODEX_API_BASE_URL', 'https://chatgpt.com/backend-api').trim().replace(/\/$/, '');
export const CODEX_OAUTH_CLIENT_ID = envValue('DISCORD_CODING_STATUS_CODEX_OAUTH_CLIENT_ID', 'app_EMoamEEZ73f0CkXaXp7hrann').trim();
export const PLAN_TEXT_OVERRIDE = envValue('DISCORD_CODING_STATUS_PLAN_TEXT').trim().replace(/\\\$/g, '$');
export const LIMITS_TEXT_OVERRIDE = envValue('DISCORD_CODING_STATUS_LIMITS_TEXT').trim();
export const PREFER_CODEX_CLI = parseBoolean(envValue('DISCORD_CODING_STATUS_PREFER_CODEX_CLI'));
export const ACTIVITY_STYLE = normalizeActivityStyle(
  envValue('DISCORD_CODING_STATUS_ACTIVITY_STYLE', DEFAULT_ACTIVITY_STYLE)
);
export const SHOW_ACTIVITY = displaySettingFromEnvironment('DISCORD_CODING_STATUS_SHOW_ACTIVITY', true);
export const SHOW_PROJECT = displaySettingFromEnvironment(
  'DISCORD_CODING_STATUS_SHOW_PROJECT',
  DETAIL_LEVEL === 'project' || DETAIL_LEVEL === 'full'
);
export const SHOW_MODEL = displaySettingFromEnvironment('DISCORD_CODING_STATUS_SHOW_MODEL', true);
export const SHOW_QUOTA = displaySettingFromEnvironment(
  'DISCORD_CODING_STATUS_SHOW_QUOTA',
  DETAIL_LEVEL === 'project' || DETAIL_LEVEL === 'full'
);
export const SHOW_CONTEXT = displaySettingFromEnvironment('DISCORD_CODING_STATUS_SHOW_CONTEXT', false);
export const SHOW_PACKAGE = displaySettingFromEnvironment(
  'DISCORD_CODING_STATUS_SHOW_PACKAGE',
  DETAIL_LEVEL === 'full'
);
export const STATE_FILE = path.resolve(resolveHomePath(envPathValue('DISCORD_CODING_STATUS_STATE_FILE', DEFAULT_STATE_FILE)));
export const STATE_MAX_AGE_MS = Number(envValue('DISCORD_CODING_STATUS_STATE_MAX_AGE_MS', String(15 * 60_000)));
export const STATE_LOCK_TIMEOUT_MS = Number(envValue('DISCORD_CODING_STATUS_STATE_LOCK_TIMEOUT_MS', '2000'));

const POLL_INTERVAL_OVERRIDE_MS = Number(
  envValue('DISCORD_CODING_STATUS_POLL_INTERVAL_MS', '10000')
);
export const POLL_INTERVAL_MS = Number.isFinite(POLL_INTERVAL_OVERRIDE_MS)
  ? Math.max(100, POLL_INTERVAL_OVERRIDE_MS)
  : 10_000;
export const STATE_WATCH_DEBOUNCE_MS = 25;
export const PROCESS_DETECTION_ENABLED = envValue(
  'DISCORD_CODING_STATUS_PROCESS_DETECTION',
  'on'
).trim().toLowerCase() !== 'off';
export const DEBUG_ENABLED = envValue('DISCORD_CODING_STATUS_DEBUG').trim().toLowerCase() === '1';
export const RECONNECT_INTERVAL_MS = 15_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const USAGE_TIMEOUT_MS = Number(envValue('DISCORD_CODING_STATUS_USAGE_TIMEOUT_MS', '8000'));
export const USAGE_REFRESH_INTERVAL_MS = Number(envValue('DISCORD_CODING_STATUS_USAGE_REFRESH_INTERVAL_MS', '60000'));
export const MAX_PRESENCE_TEXT_LENGTH = 128;
export const VERSION = readPackageVersion();

export function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf8')) as {
      version?: unknown;
    };

    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

export function getPackageRoot(): string {
  return path.basename(__dirname) === 'dist' ? path.dirname(__dirname) : __dirname;
}

export function getConfigDirectory(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_ID);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_ID);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_ID);
}

export function dim(value: string): string {
  return pc.dim(value);
}

export function success(value: string): string {
  return pc.green(value);
}

export function warning(value: string): string {
  return pc.yellow(value);
}

export function danger(value: string): string {
  return pc.red(value);
}

export function accent(value: string): string {
  return pc.cyan(value);
}

export function title(value: string): string {
  return pc.bold(pc.cyan(value));
}

export function execFileSyncString(
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

export function compactHomePath(value: string): string {
  const home = os.homedir();
  return home && value.startsWith(`${home}${path.sep}`)
    ? `~${path.sep}${value.slice(home.length + 1)}`
    : value;
}

export function shellQuoteArg(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function extractNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function extractNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function extractString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : String(error || '');
  console.error(`${dim(`[${APP_ID}]`)} ${dim(new Date().toISOString())} ${danger(message)}${detail ? `: ${detail}` : ''}`);
}
