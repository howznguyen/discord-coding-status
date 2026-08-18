import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shellQuoteArg } from './env';
import { envPathValue, resolveHomePath } from './commands/config/settings';
import { getArgString } from './commands/args';
import { findStringDeep, readHookInput } from './state-store';
import type { HookSessionState } from './core/hooks/types';

export const GROK_MANAGED_HOOK_MARKER = '--managed-by=discord-coding-status';

export const GROK_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopCancelled',
  'StopFailure',
  'SessionEnd'
] as const;

export const GROK_HOOKS_DIR = resolveHomePath(
  envPathValue('DISCORD_CODING_STATUS_GROK_HOOKS_DIR', path.join(os.homedir(), '.grok', 'hooks'))
);
export const GROK_HOOKS_FILE = path.join(GROK_HOOKS_DIR, 'discord-coding-status.json');

const DEFAULT_GROK_HOOK_TIMEOUT = 5;

export interface ManagedGrokHookMutation {
  hooksFile: string;
  installed: number;
  removed: number;
}

export interface ManagedGrokHookRemoval {
  hooksFile: string;
  removed: number;
}

export interface ManagedGrokHookStatus {
  installed: boolean;
  managedCount: number;
  eventCounts: Record<string, number>;
  missingEvents: string[];
  duplicateEvents: string[];
  unexpectedEvents: string[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

export function grokHookCommand(scriptPath: string, event: string): string {
  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'grok-hook',
    '--event',
    event,
    GROK_MANAGED_HOOK_MARKER
  ].join(' ');
}

export function isManagedGrokHook(hook: unknown): boolean {
  const record = asRecord(hook);
  const command = typeof record?.command === 'string' ? record.command : '';
  return record?.type === 'command' && command.includes(GROK_MANAGED_HOOK_MARKER);
}

function readGrokHooksFile(): JsonRecord {
  if (!fs.existsSync(GROK_HOOKS_FILE)) {
    return { hooks: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(GROK_HOOKS_FILE, 'utf8')) as unknown;
    return asRecord(parsed) || { hooks: {} };
  } catch (_) {
    return { hooks: {} };
  }
}

function countManagedGrokHooks(settings: JsonRecord): number {
  const hooks = asRecord(settings.hooks) ?? {};
  let count = 0;

  for (const groupsValue of Object.values(hooks)) {
    if (!Array.isArray(groupsValue)) {
      continue;
    }

    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      const hookList = Array.isArray(group?.hooks) ? group.hooks : [];
      count += hookList.filter(isManagedGrokHook).length;
    }
  }

  return count;
}

export function installManagedGrokHooks(scriptPath: string): ManagedGrokHookMutation {
  const previous = readGrokHooksFile();
  const removed = countManagedGrokHooks(previous);

  const hooks: JsonRecord = {};
  for (const eventName of GROK_HOOK_EVENTS) {
    hooks[eventName] = [
      {
        hooks: [
          {
            type: 'command',
            command: grokHookCommand(scriptPath, eventName),
            timeout: DEFAULT_GROK_HOOK_TIMEOUT
          }
        ]
      }
    ];
  }

  fs.mkdirSync(GROK_HOOKS_DIR, { recursive: true });
  fs.writeFileSync(GROK_HOOKS_FILE, `${JSON.stringify({ hooks }, null, 2)}\n`);

  return {
    hooksFile: GROK_HOOKS_FILE,
    installed: GROK_HOOK_EVENTS.length,
    removed
  };
}

export function removeManagedGrokHooks(): ManagedGrokHookRemoval {
  let removed = 0;
  if (fs.existsSync(GROK_HOOKS_FILE)) {
    removed = countManagedGrokHooks(readGrokHooksFile());
    fs.rmSync(GROK_HOOKS_FILE, { force: true });
  }

  return {
    hooksFile: GROK_HOOKS_FILE,
    removed
  };
}

export function getManagedGrokHookStatus(
  expectedEvents: readonly string[] = GROK_HOOK_EVENTS
): ManagedGrokHookStatus {
  if (!fs.existsSync(GROK_HOOKS_FILE)) {
    const allMissing = [...expectedEvents];
    return {
      installed: false,
      managedCount: 0,
      eventCounts: {},
      missingEvents: allMissing,
      duplicateEvents: [],
      unexpectedEvents: []
    };
  }

  const hooks = asRecord(readGrokHooksFile().hooks) ?? {};
  const eventCounts: Record<string, number> = {};
  let managedCount = 0;

  for (const [eventName, groupsValue] of Object.entries(hooks)) {
    if (!Array.isArray(groupsValue)) {
      continue;
    }

    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      const hookList = Array.isArray(group?.hooks) ? group.hooks : [];
      const count = hookList.filter(isManagedGrokHook).length;
      if (count > 0) {
        eventCounts[eventName] = (eventCounts[eventName] ?? 0) + count;
        managedCount += count;
      }
    }
  }

  const expected = [...expectedEvents];
  const expectedSet = new Set(expected);
  const missingEvents = expected.filter((eventName) => !eventCounts[eventName]);
  const duplicateEvents = expected.filter((eventName) => (eventCounts[eventName] ?? 0) > 1);
  const unexpectedEvents = Object.keys(eventCounts).filter((eventName) => !expectedSet.has(eventName));

  return {
    installed: expected.length > 0
      && missingEvents.length === 0
      && duplicateEvents.length === 0
      && unexpectedEvents.length === 0,
    managedCount,
    eventCounts,
    missingEvents,
    duplicateEvents,
    unexpectedEvents
  };
}

export function statusFromGrokHookEvent(event: string): string {
  const normalized = event.trim().toLowerCase().replace(/_/g, '');

  if (normalized === 'sessionend') {
    return 'stopped';
  }

  if (
    normalized === 'stop' ||
    normalized === 'stopcancelled' ||
    normalized === 'stopfailure'
  ) {
    return 'waiting_input';
  }

  if (
    normalized === 'sessionstart' ||
    normalized === 'userpromptsubmit' ||
    normalized === 'pretooluse' ||
    normalized === 'posttooluse'
  ) {
    return 'running';
  }

  return 'active';
}

export function activityFromGrokHook(event: string, toolName: string | null): string | null {
  const normalized = event.trim().toLowerCase().replace(/_/g, '');

  if (normalized === 'pretooluse') {
    return toolName ? `Running ${toolName}` : null;
  }

  if (normalized === 'posttooluse') {
    return toolName ? `Finished ${toolName}` : null;
  }

  return null;
}

// The Grok hook process is a passive reporter: it must ALWAYS exit 0 and never
// write to stdout (or only valid JSON) so PreToolUse/Stop hooks cannot block the
// agent. Errors are logged through the session state shape only, never a non-zero exit.
export function grokHookSessionFromArgs(args: Record<string, string | boolean>): HookSessionState {
  const input = readHookInput();
  const event = getArgString(args, 'event')
    || findStringDeep(input, ['hook_event_name', 'hook_event', 'hookEvent', 'event'])
    || 'unknown';
  const cwd = path.resolve(
    getArgString(args, 'cwd')
      || findStringDeep(input, ['cwd', 'current_working_directory', 'working_directory', 'workspace', 'workspaceRoot'])
      || process.cwd()
  );
  const sessionId = getArgString(args, 'session-id')
    || getArgString(args, 'session_id')
    || findStringDeep(input, ['session_id', 'sessionId'])
    || `grok:cli:${cwd}:${process.ppid}`;
  const toolName = findStringDeep(input, ['tool_name', 'toolName', 'tool']);

  return {
    tool: 'grok',
    surface: getArgString(args, 'surface') || 'cli',
    status: getArgString(args, 'status') || statusFromGrokHookEvent(event),
    session_id: sessionId,
    cwd,
    updated_at: Date.now(),
    project: getArgString(args, 'project') || undefined,
    package: getArgString(args, 'package') || undefined,
    title: getArgString(args, 'title') || undefined,
    activity: getArgString(args, 'activity') || activityFromGrokHook(event, toolName) || undefined,
    model: undefined
  };
}
