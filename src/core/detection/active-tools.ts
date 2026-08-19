'use strict';

import type { ToolProvider, ToolSurface } from '../providers/types';
import type { ActiveTool, ProcessInfo } from '../tools/types';

export interface DetectActiveToolsOptions {
  preferredSurfaceByFamily?: Readonly<Record<string, Exclude<ToolSurface, 'config'>>>;
  /** How long a process with no recent CPU activity still counts as active. */
  idleGraceMs?: number;
  /** Minimum CPU time (ms) consumed between polls that marks a process active. */
  activeCpuMs?: number;
}

const DEFAULT_IDLE_GRACE_MS = 5 * 60_000;
const DEFAULT_ACTIVE_CPU_MS = 50;

interface ProviderProcessMatch {
  provider: ToolProvider;
  processInfo: ProcessInfo;
  registryIndex: number;
}

interface ProcessActivity {
  cpuMs: number;
  lastActiveAt: number;
  lastSeenAt: number;
}

// Tracks cumulative CPU time per PID between polls so process detection can
// tell "a session that is actively doing work" apart from "a process that is
// merely still alive". Interactive coding agents (Pi, OpenCode, Codex CLI)
// stay alive while waiting for input, so an alive process alone is not
// evidence of an active session: a Knowns/Pi session left open for hours
// would otherwise keep reporting as active forever.
const processActivityCache = new Map<number, ProcessActivity>();
const MAX_CACHE_ENTRIES = 512;

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

/**
 * Updates the cumulative-CPU tracking cache for the given process snapshot and
 * returns per-PID activity records. Processes with no CPU data (or no PID) are
 * not tracked and are always treated as active, preserving fallback behavior.
 */
function trackProcessActivity(
  candidates: ProcessInfo[],
  now: number,
  activeCpuMs: number
): Map<number, ProcessActivity> {
  const activity = new Map<number, ProcessActivity>();
  const livePids = new Set<number>();

  for (const candidate of candidates) {
    if (typeof candidate.pid !== 'number' || typeof candidate.cpuMs !== 'number') {
      continue;
    }

    livePids.add(candidate.pid);
    const previous = processActivityCache.get(candidate.pid);
    const cpuDelta = previous ? candidate.cpuMs - previous.cpuMs : candidate.cpuMs;
    const lastActiveAt = previous && cpuDelta < activeCpuMs
      ? previous.lastActiveAt
      : now;
    const record: ProcessActivity = {
      cpuMs: candidate.cpuMs,
      lastActiveAt,
      lastSeenAt: now
    };
    processActivityCache.set(candidate.pid, record);
    activity.set(candidate.pid, record);
  }

  for (const pid of processActivityCache.keys()) {
    if (!livePids.has(pid)) {
      processActivityCache.delete(pid);
    }
  }

  if (processActivityCache.size > MAX_CACHE_ENTRIES) {
    const overflow = processActivityCache.size - MAX_CACHE_ENTRIES;
    const oldest = [...processActivityCache.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt);
    for (let index = 0; index < overflow; index += 1) {
      processActivityCache.delete(oldest[index][0]);
    }
  }

  return activity;
}

function isRecentlyActive(record: ProcessActivity | undefined, now: number, idleGraceMs: number): boolean {
  if (!record) {
    return true;
  }

  return now - record.lastActiveAt <= idleGraceMs;
}

function activityOrder(candidate: ProcessInfo, activity: Map<number, ProcessActivity>, now: number): number {
  return activity.get(candidate.pid)?.lastActiveAt ?? now;
}

export function detectActiveTools(
  processLines: ProcessInfo[],
  providers: readonly ToolProvider[],
  options: DetectActiveToolsOptions = {}
): ActiveTool[] {
  const now = Date.now();
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const activeCpuMs = options.activeCpuMs ?? DEFAULT_ACTIVE_CPU_MS;
  const candidates = processLines.filter((line) => !isIgnoredProcess(line));
  const activity = trackProcessActivity(candidates, now, activeCpuMs);

  // Only processes with evidence of recent work (CPU time consumed recently,
  // or a recent start) count as active sessions. When several processes of the
  // same tool are alive (for example multiple idle Pi sessions under Knowns),
  // prefer the most recently active one instead of an arbitrary first match.
  const rankedCandidates = [...candidates]
    .filter((candidate) => isRecentlyActive(activity.get(candidate.pid), now, idleGraceMs))
    .sort((left, right) => {
      const orderDelta = activityOrder(right, activity, now) - activityOrder(left, activity, now);
      if (orderDelta !== 0) {
        return orderDelta;
      }

      return (right.cpuMs || 0) - (left.cpuMs || 0);
    });

  const matches = providers.flatMap((provider, registryIndex): ProviderProcessMatch[] => {
    if (!provider.process || !provider.presence) {
      return [];
    }

    const processInfo = rankedCandidates.find((candidate) => provider.process?.matches(candidate));
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
        source: 'process',
        providerId: selected.provider.id,
        processInfo: selected.processInfo,
        // Process-detected tools have no hook timestamps; stamp them with the
        // detection time so the newest-session selection orders two process
        // tools sensibly. This timestamp is re-stamped every poll, so it must
        // never be compared against a hook timestamp — `selectNewestTool`
        // ranks by source first for exactly that reason.
        updatedAt: now
      };
    });
}
