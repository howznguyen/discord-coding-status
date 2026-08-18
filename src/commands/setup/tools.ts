'use strict';

import { createColors } from 'picocolors';
import type { SetupToolDetection } from '../../core/detection/types';
import type { ToolProvider } from '../../core/providers/types';
import type { SetupHookSummary, SetupToolRow } from './types';
import {
  detectedHookCapabilityForSetup
} from './policy';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface ToolSummarySource {
  detections: SetupToolDetection[];
  providers: readonly ToolProvider[];
  claudeHooks?: SetupHookSummary | null;
  codexHooks?: SetupHookSummary | null;
  grokHooks?: SetupHookSummary | null;
  opencodePluginInstalled?: boolean;
  piExtensionInstalled?: boolean;
  args: Record<string, string | boolean>;
}

function getDetectionText(cliDetected: boolean, appDetected: boolean): string {
  if (cliDetected && appDetected) return `${pc.green('✔')} CLI + App`;
  if (cliDetected) return `${pc.green('✔')} CLI`;
  if (appDetected) return `${pc.green('✔')} App`;
  return `${pc.dim('✖')} Not found`;
}

function getHookText(
  hooks: SetupHookSummary | null | undefined,
  disabled: boolean,
  detected: boolean
): string {
  if (hooks && hooks.installed > 0) {
    return pc.green(`✔ ${hooks.installed} hooks active`);
  }
  if (disabled) {
    return pc.yellow('✖ Disabled');
  }
  if (!detected) {
    return pc.dim('· Not detected');
  }
  return pc.dim('· Skipped');
}

export function buildSetupToolRows(source: ToolSummarySource): SetupToolRow[] {
  const {
    detections,
    providers,
    claudeHooks,
    codexHooks,
    grokHooks,
    opencodePluginInstalled,
    piExtensionInstalled,
    args
  } = source;

  const isDetected = (key: string): boolean =>
    detections.find((d) => d.key === key)?.detected ?? false;

  const hookResults = new Map<string, SetupHookSummary | null>();
  if (claudeHooks !== undefined) hookResults.set('claude', claudeHooks);
  if (codexHooks !== undefined) hookResults.set('codex', codexHooks);
  if (grokHooks !== undefined) hookResults.set('grok', grokHooks);

  const families = new Set<string>();
  for (const provider of providers) {
    if (provider.family) {
      families.add(provider.family);
    }
  }

  const rows: SetupToolRow[] = [];

  for (const family of families) {
    const familyProviders = providers.filter((p) => p.family === family);
    const cliProvider = familyProviders.find((p) => p.process?.surface === 'cli' || p.setup?.probe.kind === 'executable');
    const appProvider = familyProviders.find((p) => p.process?.surface === 'desktop' || p.setup?.probe.kind === 'desktop');

    const cliDetected = cliProvider ? isDetected(cliProvider.id) : false;
    const appDetected = appProvider ? isDetected(appProvider.id) : false;

    const discordLabel = familyProviders.find((p) => p.discord?.label)?.discord?.label;
    const name = discordLabel || (family.charAt(0).toUpperCase() + family.slice(1));

    let integration = pc.dim('· None required');

    const hasHooks = familyProviders.some((p) => p.hooks && p.hooks.length > 0);
    if (hasHooks) {
      const hookResult = hookResults.get(family);
      const disabled = Boolean(args[`no-${family}-hooks`] || args[`no_${family}_hooks`]);
      const detected = detectedHookCapabilityForSetup(detections, providers, family);
      integration = getHookText(hookResult, disabled, detected);
    } else if (family === 'opencode') {
      integration = opencodePluginInstalled ? pc.green('✔ Plugin active') : pc.dim('· Plugin optional');
    } else if (family === 'pi') {
      integration = piExtensionInstalled ? pc.green('✔ Extension active') : pc.dim('· Extension optional');
    }

    rows.push({
      name,
      detection: getDetectionText(cliDetected, appDetected),
      integration
    });
  }

  return rows;
}
