'use strict';

import type { SetupToolDetection } from '../../core/detection/types';
import type { HookCapability, ToolProvider } from '../../core/providers/types';

export function detectedHookCapabilityForSetup(
  detections: SetupToolDetection[],
  providers: readonly ToolProvider[],
  capability: HookCapability
): boolean {
  const detectedProviderIds = new Set(
    detections.filter((item) => item.detected).map((item) => item.key)
  );
  return providers.some(
    (provider) => detectedProviderIds.has(provider.id) && provider.hooks?.includes(capability)
  );
}

export function detectedCodexForSetup(
  detections: SetupToolDetection[],
  providers: readonly ToolProvider[]
): boolean {
  return detectedHookCapabilityForSetup(detections, providers, 'codex');
}

export function detectedClaudeForSetup(
  detections: SetupToolDetection[],
  providers: readonly ToolProvider[]
): boolean {
  return detectedHookCapabilityForSetup(detections, providers, 'claude');
}

function shouldInstallHooks(
  args: Record<string, string | boolean>,
  detections: SetupToolDetection[],
  providers: readonly ToolProvider[],
  capability: HookCapability,
  enabledFlag: string,
  disabledFlag: string
): boolean {
  if (args[disabledFlag] || args[disabledFlag.replace(/-/g, '_')]) {
    return false;
  }
  if (args[enabledFlag] || args[enabledFlag.replace(/-/g, '_')]) {
    return true;
  }
  return detectedHookCapabilityForSetup(detections, providers, capability);
}

export function shouldInstallCodexHooks(
  args: Record<string, string | boolean>,
  detections: SetupToolDetection[],
  providers: readonly ToolProvider[]
): boolean {
  return shouldInstallHooks(
    args,
    detections,
    providers,
    'codex',
    'codex-hooks',
    'no-codex-hooks'
  );
}

export function shouldInstallClaudeHooks(
  args: Record<string, string | boolean>,
  detections: SetupToolDetection[],
  providers: readonly ToolProvider[]
): boolean {
  return shouldInstallHooks(
    args,
    detections,
    providers,
    'claude',
    'claude-hooks',
    'no-claude-hooks'
  );
}
