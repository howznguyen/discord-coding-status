'use strict';

import * as fs from 'node:fs';
import type { HookCapability, HookInstaller, ToolProvider } from './core/providers/types';
import type { SetupToolDetection } from './core/detection/types';
import { CLAUDE_CONFIG_DIR, CLAUDE_SETTINGS_FILE, shellQuoteArg } from './env';
import { readClaudeSettings } from './state-store';
import {
  CLAUDE_LIFECYCLE_HOOK_EVENTS,
  CLAUDE_MANAGED_HOOK_MARKER,
  getManagedClaudeHookStatus,
  installManagedClaudeHooks,
  removeManagedClaudeHooks,
  writeClaudeSettings
} from './claude-hooks';
import { codexHookInstaller } from './codex-hooks';
import {
  GROK_HOOKS_DIR,
  GROK_HOOKS_FILE,
  GROK_HOOK_EVENTS,
  getManagedGrokHookStatus,
  installManagedGrokHooks,
  removeManagedGrokHooks
} from './grok-hooks';
import { toolProviders } from './providers/registry';

const CLAUDE_HOOK_TIMEOUT_SECONDS = 5;

export function claudeHookCommand(scriptPath: string, event: string): string {
  return [
    shellQuoteArg(process.execPath),
    shellQuoteArg(scriptPath),
    'claude-hook',
    '--event',
    shellQuoteArg(event),
    CLAUDE_MANAGED_HOOK_MARKER
  ].join(' ');
}

export const claudeHookInstaller: HookInstaller = {
  capability: 'claude',
  label: 'Claude Code',
  events: CLAUDE_LIFECYCLE_HOOK_EVENTS,
  install: (scriptPath) => {
    const result = installManagedClaudeHooks(readClaudeSettings(), {
      events: CLAUDE_LIFECYCLE_HOOK_EVENTS,
      commandForEvent: (eventName) => claudeHookCommand(scriptPath, eventName),
      timeout: CLAUDE_HOOK_TIMEOUT_SECONDS
    });
    writeClaudeSettings(CLAUDE_SETTINGS_FILE, result.settings);
    return {
      target: CLAUDE_SETTINGS_FILE,
      installed: result.installed,
      removed: result.removed
    };
  },
  uninstall: () => {
    const result = removeManagedClaudeHooks(readClaudeSettings());
    if (result.removed > 0) {
      writeClaudeSettings(CLAUDE_SETTINGS_FILE, result.settings);
    }
    return { target: CLAUDE_SETTINGS_FILE, removed: result.removed };
  },
  status: () => {
    const status = getManagedClaudeHookStatus(readClaudeSettings(), CLAUDE_LIFECYCLE_HOOK_EVENTS);
    return {
      target: CLAUDE_SETTINGS_FILE,
      targetExists: fs.existsSync(CLAUDE_SETTINGS_FILE),
      installed: status.installed,
      managedCount: status.managedCount,
      expectedEvents: CLAUDE_LIFECYCLE_HOOK_EVENTS,
      missingEvents: status.missingEvents,
      duplicateEvents: status.duplicateEvents,
      unexpectedEvents: status.unexpectedEvents,
      details: { claudeConfigDir: CLAUDE_CONFIG_DIR, eventCounts: status.eventCounts }
    };
  }
};

export const grokHookInstaller: HookInstaller = {
  capability: 'grok',
  label: 'Grok Code',
  events: GROK_HOOK_EVENTS,
  install: (scriptPath) => {
    const result = installManagedGrokHooks(scriptPath);
    return { target: result.hooksFile, installed: result.installed, removed: result.removed };
  },
  uninstall: () => {
    const result = removeManagedGrokHooks();
    return { target: result.hooksFile, removed: result.removed };
  },
  status: () => {
    const status = getManagedGrokHookStatus();
    return {
      target: GROK_HOOKS_FILE,
      targetExists: fs.existsSync(GROK_HOOKS_FILE),
      installed: status.installed,
      managedCount: status.managedCount,
      expectedEvents: GROK_HOOK_EVENTS,
      missingEvents: status.missingEvents,
      duplicateEvents: status.duplicateEvents,
      unexpectedEvents: status.unexpectedEvents,
      details: { grokHooksDir: GROK_HOOKS_DIR, eventCounts: status.eventCounts }
    };
  },
  notes: ['Grok hooks live in the globally trusted ~/.grok/hooks directory.']
};

/**
 * One installer per harness. A provider declares `hooks: ['<capability>']`; the
 * matching installer here supplies the behaviour, so the CLI never names a
 * harness directly. Adding a harness means adding its hook module and one line
 * below.
 *
 * These live outside `src/providers/` on purpose: the layering test in
 * `test/architecture.integration.test.js` keeps that directory declarative by
 * forbidding imports of app modules like `env` and `state-store`, which every
 * installer needs for its config paths.
 */
const builtInHookInstallers: readonly HookInstaller[] = [
  codexHookInstaller,
  claudeHookInstaller,
  grokHookInstaller
];

export function validateHookInstallers(
  installers: readonly HookInstaller[],
  providers: readonly ToolProvider[] = toolProviders
): void {
  const seen = new Set<HookCapability>();
  const declared = new Set<HookCapability>();

  for (const provider of providers) {
    for (const capability of provider.hooks ?? []) {
      declared.add(capability);
    }
  }

  for (const installer of installers) {
    if (!installer.capability.trim()) {
      throw new Error('Hook installer capability cannot be empty.');
    }
    if (seen.has(installer.capability)) {
      throw new Error(`Duplicate hook installer capability: ${installer.capability}`);
    }
    if (!declared.has(installer.capability)) {
      throw new Error(`Hook installer has no provider declaring it: ${installer.capability}`);
    }
    if (installer.events.length === 0) {
      throw new Error(`Hook installer declares no events: ${installer.capability}`);
    }
    seen.add(installer.capability);
  }
}

validateHookInstallers(builtInHookInstallers);

export const hookInstallers: readonly HookInstaller[] = Object.freeze([...builtInHookInstallers]);

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function findHookInstaller(
  harness: string,
  installers: readonly HookInstaller[] = hookInstallers,
  providers: readonly ToolProvider[] = toolProviders
): HookInstaller | null {
  const normalized = normalizeName(harness);
  if (!normalized) {
    return null;
  }

  const direct = installers.find((installer) => normalizeName(installer.capability) === normalized);
  if (direct) {
    return direct;
  }

  // Accept labels, provider ids, and families so `hooks setup claudeCode`,
  // `hooks setup "Grok Code"`, and `hooks setup grok` all resolve.
  const viaLabel = installers.find((installer) => normalizeName(installer.label) === normalized);
  if (viaLabel) {
    return viaLabel;
  }

  const provider = providers.find((candidate) => {
    return [candidate.id, candidate.family].some((value) => normalizeName(value) === normalized)
      && (candidate.hooks?.length ?? 0) > 0;
  });
  if (!provider) {
    return null;
  }

  return installers.find((installer) => provider.hooks?.includes(installer.capability)) || null;
}

/**
 * Installers whose harness was actually found on this machine. `hooks setup`
 * with no harness argument uses this so it never writes hooks for a tool the
 * user has not installed.
 */
export function detectedHookInstallers(
  detections: readonly SetupToolDetection[],
  installers: readonly HookInstaller[] = hookInstallers,
  providers: readonly ToolProvider[] = toolProviders
): HookInstaller[] {
  const detectedIds = new Set(
    detections.filter((detection) => detection.detected).map((detection) => detection.key)
  );
  const detectedCapabilities = new Set<HookCapability>();

  for (const provider of providers) {
    if (!detectedIds.has(provider.id)) {
      continue;
    }
    for (const capability of provider.hooks ?? []) {
      detectedCapabilities.add(capability);
    }
  }

  return installers.filter((installer) => detectedCapabilities.has(installer.capability));
}
