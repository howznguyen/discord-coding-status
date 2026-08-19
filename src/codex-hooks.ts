'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HookInstallOutcome,
  HookInstaller,
  HookRemovalOutcome,
  HookStatusOutcome
} from './core/providers/types';
import {
  APP_ID,
  APP_TITLE,
  CODEX_HOME,
  CODEX_HOOKS_FILE,
  CODEX_HOOK_EVENTS,
  asRecord,
  logError,
  powershellCommandLine,
  shellQuoteArg
} from './env';

type JsonRecord = Record<string, unknown>;

function codexHookArgv(scriptPath: string, event: string): string[] {
  return [process.execPath, scriptPath, 'codex-hook', '--event', event];
}

// Codex dispatches hooks through the host's default shell. On Windows that is
// `powershell.exe -NoProfile -Command`, which reports a ParserError on a command
// line starting with a quoted path unless the call operator invokes it.
export function codexHookCommandWindows(scriptPath: string, event: string): string {
  return powershellCommandLine(codexHookArgv(scriptPath, event));
}

// `commandWindows` is only honoured by newer Codex builds, so an installation
// running on Windows also writes the PowerShell form into `command`.
export function codexHookCommand(scriptPath: string, event: string): string {
  if (process.platform === 'win32') {
    return codexHookCommandWindows(scriptPath, event);
  }

  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'codex-hook',
    '--event',
    shellQuoteArg(event)
  ].join(' ');
}

function readCodexHooks(): JsonRecord {
  if (!fs.existsSync(CODEX_HOOKS_FILE)) {
    return { hooks: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CODEX_HOOKS_FILE, 'utf8')) as unknown;
    return asRecord(parsed) || { hooks: {} };
  } catch (error) {
    logError('Failed to read Codex hooks configuration', error);
    return { hooks: {} };
  }
}

function writeCodexHooks(config: JsonRecord): void {
  fs.mkdirSync(path.dirname(CODEX_HOOKS_FILE), { recursive: true });

  if (fs.existsSync(CODEX_HOOKS_FILE)) {
    fs.copyFileSync(CODEX_HOOKS_FILE, `${CODEX_HOOKS_FILE}.bak`);
  }

  fs.writeFileSync(CODEX_HOOKS_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

export function isManagedCodexHook(hook: unknown): boolean {
  const record = asRecord(hook);
  if (!record) {
    return false;
  }

  const statusMessage = typeof record.statusMessage === 'string' ? record.statusMessage : '';
  const command = typeof record.command === 'string' ? record.command : '';

  return statusMessage === APP_TITLE
    || (command.includes('codex-hook') && command.includes(APP_ID));
}

function removeManagedCodexHooks(config: JsonRecord): number {
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
          const managed = isManagedCodexHook(hook);
          if (managed) {
            removed += 1;
          }

          return !managed;
        });

        return { ...group, hooks: nextHookList };
      })
      .filter((groupValue) => {
        const group = asRecord(groupValue);
        return !group || !Array.isArray(group.hooks) || group.hooks.length > 0;
      });

    if (nextGroups.length > 0) {
      hooks[eventName] = nextGroups;
    } else {
      delete hooks[eventName];
    }
  }

  return removed;
}

export function installCodexHooks(scriptPath: string): HookInstallOutcome {
  const config = readCodexHooks();
  const hooks = asRecord(config.hooks) || {};
  config.hooks = hooks;
  const removed = removeManagedCodexHooks(config);
  let installed = 0;

  for (const eventName of CODEX_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
    groups.push({
      hooks: [
        {
          type: 'command',
          command: codexHookCommand(scriptPath, eventName),
          commandWindows: codexHookCommandWindows(scriptPath, eventName),
          statusMessage: APP_TITLE
        }
      ]
    });
    hooks[eventName] = groups;
    installed += 1;
  }

  writeCodexHooks(config);
  return { target: CODEX_HOOKS_FILE, installed, removed };
}

export function uninstallCodexHooks(): HookRemovalOutcome {
  const config = readCodexHooks();
  const removed = removeManagedCodexHooks(config);

  if (removed > 0) {
    writeCodexHooks(config);
  }

  return { target: CODEX_HOOKS_FILE, removed };
}

export function codexHooksStatus(): HookStatusOutcome {
  const hooks = asRecord(readCodexHooks().hooks) || {};
  const managedHooks: Record<string, string[]> = {};
  const eventCounts: Record<string, number> = {};
  let managedCount = 0;

  for (const [eventName, groupsValue] of Object.entries(hooks)) {
    if (!Array.isArray(groupsValue)) {
      continue;
    }

    const matching: string[] = [];
    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      const hookList = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const hook of hookList) {
        if (!isManagedCodexHook(hook)) {
          continue;
        }

        const record = asRecord(hook);
        matching.push(typeof record?.command === 'string' ? record.command : '');
      }
    }

    if (matching.length > 0) {
      managedHooks[eventName] = matching;
      eventCounts[eventName] = matching.length;
      managedCount += matching.length;
    }
  }

  const expected = [...CODEX_HOOK_EVENTS];
  const expectedSet = new Set<string>(expected);
  const missingEvents = expected.filter((eventName) => !eventCounts[eventName]);
  const duplicateEvents = expected.filter((eventName) => (eventCounts[eventName] ?? 0) > 1);
  const unexpectedEvents = Object.keys(eventCounts).filter((eventName) => !expectedSet.has(eventName));

  return {
    target: CODEX_HOOKS_FILE,
    targetExists: fs.existsSync(CODEX_HOOKS_FILE),
    installed: missingEvents.length === 0 && duplicateEvents.length === 0 && unexpectedEvents.length === 0,
    managedCount,
    expectedEvents: expected,
    missingEvents,
    duplicateEvents,
    unexpectedEvents,
    details: { codexHome: CODEX_HOME, managedHooks }
  };
}

export const codexHookInstaller: HookInstaller = {
  capability: 'codex',
  label: 'Codex',
  events: CODEX_HOOK_EVENTS,
  install: installCodexHooks,
  uninstall: uninstallCodexHooks,
  status: codexHooksStatus,
  notes: ['Run `/hooks` once in Codex to review and trust the new hooks.']
};
