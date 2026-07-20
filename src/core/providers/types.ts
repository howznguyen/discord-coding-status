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

export interface ToolProvider {
  id: string;
  family: ToolFamily;
  presence?: ToolDefinition;
  process?: ProcessCapability;
  setup?: SetupCapability;
  hooks?: readonly HookCapability[];
  discord?: DiscordCapability;
}
