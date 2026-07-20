'use strict';

import type { ToolProvider, ToolSurface } from '../providers/types';
import type { ActiveTool, ProcessInfo } from '../tools/types';

export interface DetectActiveToolsOptions {
  preferredSurfaceByFamily?: Readonly<Record<string, Exclude<ToolSurface, 'config'>>>;
}

interface ProviderProcessMatch {
  provider: ToolProvider;
  processInfo: ProcessInfo;
  registryIndex: number;
}

function processText(processInfo: ProcessInfo | string): string {
  return typeof processInfo === 'string' ? processInfo : processInfo.line;
}

function isIgnoredProcess(processInfo: ProcessInfo | string): boolean {
  const normalized = processText(processInfo).toLowerCase().replace(/\s+/g, ' ');

  return normalized.includes('discord-coding-status.js')
    || normalized.includes('discord-coding-status.ts')
    || normalized.includes('grep ')
    || normalized.includes(' ps ')
    || normalized.includes('/ps ')
    || normalized.includes('discord helper');
}

function providerRank(
  match: ProviderProcessMatch,
  preferredSurface: Exclude<ToolSurface, 'config'> | undefined
): number {
  const preferenceBoost = preferredSurface && match.provider.process?.surface === preferredSurface
    ? 1_000_000
    : 0;
  return preferenceBoost + (match.provider.process?.priority || 0) * 1_000 - match.registryIndex;
}

export function detectActiveTools(
  processLines: ProcessInfo[],
  providers: readonly ToolProvider[],
  options: DetectActiveToolsOptions = {}
): ActiveTool[] {
  const candidates = processLines.filter((line) => !isIgnoredProcess(line));
  const matches = providers.flatMap((provider, registryIndex): ProviderProcessMatch[] => {
    if (!provider.process || !provider.presence) {
      return [];
    }

    const processInfo = candidates.find((candidate) => provider.process?.matches(candidate));
    return processInfo ? [{ provider, processInfo, registryIndex }] : [];
  });

  const families = new Map<string, ProviderProcessMatch[]>();
  for (const match of matches) {
    const familyMatches = families.get(match.provider.family) || [];
    familyMatches.push(match);
    families.set(match.provider.family, familyMatches);
  }

  return [...families.values()]
    .sort((left, right) => {
      const leftOrder = Math.min(...left.map((match) => match.provider.process?.familyOrder || 0));
      const rightOrder = Math.min(...right.map((match) => match.provider.process?.familyOrder || 0));
      return leftOrder - rightOrder;
    })
    .map((familyMatches): ActiveTool => {
      const family = familyMatches[0].provider.family;
      const preferredSurface = options.preferredSurfaceByFamily?.[family];
      const selected = [...familyMatches].sort(
        (left, right) => providerRank(right, preferredSurface) - providerRank(left, preferredSurface)
      )[0];

      return {
        ...selected.provider.presence!,
        providerId: selected.provider.id,
        processInfo: selected.processInfo
      };
    });
}
