'use strict';

import type { ProcessInfo, ToolDefinition, ToolFamily } from '../tools/types';

export type ToolSurface = 'cli' | 'desktop' | 'config';
export type HookCapability = string;

export interface ExecutableInstallationProbe {
  kind: 'executable';
  candidates: readonly string[];
}

export interface MacDesktopCandidate {
  bundleName: string;
  bundleIdentifier?: string;
  requiredRelativePaths?: readonly string[];
}

export interface DesktopInstallationProbe {
  kind: 'desktop';
  macCandidates: readonly MacDesktopCandidate[];
  windowsStartNames: readonly string[];
}

export interface PathInstallationProbe {
  kind: 'path';
  defaultPath: string;
}

export type InstallationProbe =
  | ExecutableInstallationProbe
  | DesktopInstallationProbe
  | PathInstallationProbe;

export interface SetupCapability {
  name: string;
  order: number;
  probe: InstallationProbe;
}

export interface ProcessCapability {
  surface: Exclude<ToolSurface, 'config'>;
  priority: number;
  familyOrder: number;
  matches: (process: ProcessInfo | string) => boolean;
}

export interface DiscordCapability {
  application: string;
  label: string;
  defaultClientId?: string;
  clientIdEnvironment?: string;
  imageKeyEnvironment?: string;
}

export interface HookInstallOutcome {
  target: string;
  installed: number;
  removed: number;
}

export interface HookRemovalOutcome {
  target: string;
  removed: number;
}

export interface HookStatusOutcome {
  target: string;
  targetExists: boolean;
  installed: boolean;
  managedCount: number;
  expectedEvents: readonly string[];
  missingEvents: readonly string[];
  duplicateEvents: readonly string[];
  unexpectedEvents: readonly string[];
  details?: Record<string, unknown>;
}

/**
 * The executable half of a `hooks` capability tag. Each harness owns one of
 * these so the CLI can install, remove, and report hooks without knowing which
 * harness it is talking to.
 *
 * Installers live in `src/providers/hook-installers.ts` rather than on
 * `ToolProvider` itself: `src/env.ts` imports the provider registry, so a
 * provider that reached back into `env.ts` for its config paths would close an
 * import cycle and leave `toolProviders` undefined during module init.
 */
export interface HookInstaller {
  capability: HookCapability;
  label: string;
  events: readonly string[];
  install: (scriptPath: string) => HookInstallOutcome;
  uninstall: () => HookRemovalOutcome;
  status: () => HookStatusOutcome;
  notes?: readonly string[];
}

export interface ToolProvider {
  id: string;
  family: ToolFamily;
  presence?: ToolDefinition;
  process?: ProcessCapability;
  setup?: SetupCapability;
  hooks?: readonly HookCapability[];
  discord?: DiscordCapability;
}
