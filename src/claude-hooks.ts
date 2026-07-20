import fs = require('node:fs');
import path = require('node:path');

export const CLAUDE_MANAGED_HOOK_MARKER = '--managed-by=discord-coding-status';
export const CLAUDE_LIFECYCLE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd'
] as const;

const DEFAULT_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type ClaudeModelSource = 'hook' | 'transcript' | 'last-known' | 'unavailable';

export interface ClaudeTranscriptTail {
  text: string;
  startsMidLine?: boolean;
}

export interface ClaudeTranscriptReadOptions {
  maxBytes?: number;
  readTail?: (transcriptPath: string, maxBytes: number) => ClaudeTranscriptTail;
}

export interface ClaudeSessionModelObservationInput {
  sessionId: unknown;
  hookInput?: unknown;
  transcriptModel?: unknown;
}

export interface ClaudeSessionModelObservation {
  sessionId: string | null;
  model: string | null;
  source: ClaudeModelSource;
  changed: boolean;
}

export interface ManagedClaudeHookOptions {
  events: readonly string[];
  commandForEvent: (eventName: string) => string;
  marker?: string;
  matcher?: string;
  timeout?: number;
}

export interface ManagedClaudeHookMutation {
  settings: JsonRecord;
  installed: number;
  removed: number;
}

export interface ManagedClaudeHookRemoval {
  settings: JsonRecord;
  removed: number;
}

export interface ManagedClaudeHookStatus {
  installed: boolean;
  managedCount: number;
  eventCounts: Record<string, number>;
  missingEvents: string[];
  duplicateEvents: string[];
  unexpectedEvents: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function directModelFromRecord(record: JsonRecord | null): string | null {
  if (!record) {
    return null;
  }

  return normalizeClaudeModelId(record.model ?? record.model_id ?? record.modelId);
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function defaultReadTranscriptTail(transcriptPath: string, maxBytes: number): ClaudeTranscriptTail {
  const resolvedPath = path.resolve(transcriptPath);
  const stat = fs.statSync(resolvedPath);
  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  const buffer = Buffer.alloc(length);
  let fileDescriptor: number | null = null;

  try {
    fileDescriptor = fs.openSync(resolvedPath, 'r');
    fs.readSync(fileDescriptor, buffer, 0, length, start);
  } finally {
    if (fileDescriptor !== null) {
      fs.closeSync(fileDescriptor);
    }
  }

  return {
    text: buffer.toString('utf8'),
    startsMidLine: start > 0
  };
}

function transcriptLines(tail: ClaudeTranscriptTail): string[] {
  let text = tail.text;
  if (tail.startsMidLine) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  }

  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && !lines[lines.length - 1].trim()) {
    lines.pop();
  }

  return lines;
}

function uniqueEvents(events: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const eventName of events) {
    const normalized = eventName.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }

  return unique;
}

function managedMarker(marker: string | undefined): string {
  const normalized = marker?.trim() || CLAUDE_MANAGED_HOOK_MARKER;
  return normalized;
}

export function normalizeClaudeModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

export function extractClaudeSessionId(hookInput: unknown): string | null {
  const input = asRecord(hookInput);
  return normalizeSessionId(input?.session_id ?? input?.sessionId);
}

export function extractClaudeModelFromHookInput(hookInput: unknown): string | null {
  const input = asRecord(hookInput);
  return directModelFromRecord(input) ?? directModelFromRecord(asRecord(input?.metadata));
}

export function extractClaudeModelFromTranscriptRecord(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return directModelFromRecord(record)
    ?? directModelFromRecord(asRecord(record.message))
    ?? directModelFromRecord(asRecord(record.metadata))
    ?? directModelFromRecord(asRecord(record.payload));
}

export function extractClaudeModelFromTranscriptJsonl(jsonl: string): string | null {
  const lines = transcriptLines({ text: jsonl });
  const newestLineIndex = lines.length - 1;

  for (let index = newestLineIndex; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch (_) {
      // Claude writes transcripts asynchronously. A partial newest line means the
      // transcript is not caught up yet, so callers should retain last-known state.
      if (index === newestLineIndex) {
        return null;
      }
      continue;
    }

    const model = extractClaudeModelFromTranscriptRecord(record);
    if (model) {
      return model;
    }
  }

  return null;
}

export function readClaudeModelFromTranscript(
  transcriptPath: unknown,
  options: ClaudeTranscriptReadOptions = {}
): string | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) {
    return null;
  }

  const maxBytes = Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0
    ? Math.floor(Number(options.maxBytes))
    : DEFAULT_TRANSCRIPT_TAIL_BYTES;
  const readTail = options.readTail ?? defaultReadTranscriptTail;

  try {
    const tail = readTail(transcriptPath.trim(), maxBytes);
    const lines = transcriptLines(tail);
    return extractClaudeModelFromTranscriptJsonl(lines.join('\n'));
  } catch (_) {
    return null;
  }
}

export class ClaudeSessionModelTracker {
  private readonly modelsBySession = new Map<string, string>();

  observe(input: ClaudeSessionModelObservationInput): ClaudeSessionModelObservation {
    const sessionId = normalizeSessionId(input.sessionId);
    const hookModel = extractClaudeModelFromHookInput(input.hookInput);
    const transcriptModel = normalizeClaudeModelId(input.transcriptModel);
    const candidate = hookModel ?? transcriptModel;
    const source: ClaudeModelSource = hookModel
      ? 'hook'
      : transcriptModel
        ? 'transcript'
        : 'unavailable';

    if (!sessionId) {
      return {
        sessionId: null,
        model: candidate,
        source,
        changed: false
      };
    }

    const lastKnown = this.modelsBySession.get(sessionId) ?? null;
    if (candidate) {
      this.modelsBySession.set(sessionId, candidate);
      return {
        sessionId,
        model: candidate,
        source,
        changed: lastKnown !== candidate
      };
    }

    return {
      sessionId,
      model: lastKnown,
      source: lastKnown ? 'last-known' : 'unavailable',
      changed: false
    };
  }

  get(sessionId: unknown): string | null {
    const normalized = normalizeSessionId(sessionId);
    return normalized ? this.modelsBySession.get(normalized) ?? null : null;
  }

  clear(sessionId: unknown): boolean {
    const normalized = normalizeSessionId(sessionId);
    return normalized ? this.modelsBySession.delete(normalized) : false;
  }

  clearAll(): void {
    this.modelsBySession.clear();
  }
}

export function isManagedClaudeHook(hook: unknown, marker?: string): boolean {
  const record = asRecord(hook);
  const command = typeof record?.command === 'string' ? record.command : '';
  return record?.type === 'command' && command.includes(managedMarker(marker));
}

export function removeManagedClaudeHooks(settings: unknown, marker?: string): ManagedClaudeHookRemoval {
  const source = asRecord(settings) ?? {};
  const nextSettings: JsonRecord = { ...source };
  const sourceHooks = asRecord(source.hooks);
  if (!sourceHooks) {
    return { settings: nextSettings, removed: 0 };
  }

  const nextHooks: JsonRecord = { ...sourceHooks };
  let removed = 0;

  for (const [eventName, groupsValue] of Object.entries(sourceHooks)) {
    if (!Array.isArray(groupsValue)) {
      continue;
    }

    const nextGroups: unknown[] = [];
    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      const hookList = Array.isArray(group?.hooks) ? group.hooks : null;
      if (!group || !hookList) {
        nextGroups.push(groupValue);
        continue;
      }

      const nextHookList = hookList.filter((hook) => {
        const owned = isManagedClaudeHook(hook, marker);
        if (owned) {
          removed += 1;
        }
        return !owned;
      });

      if (nextHookList.length > 0 || nextHookList.length === hookList.length) {
        nextGroups.push(nextHookList.length === hookList.length
          ? groupValue
          : { ...group, hooks: nextHookList });
      }
    }

    if (nextGroups.length > 0 || groupsValue.length === 0) {
      nextHooks[eventName] = nextGroups;
    } else {
      delete nextHooks[eventName];
    }
  }

  nextSettings.hooks = nextHooks;
  return { settings: nextSettings, removed };
}

export function installManagedClaudeHooks(
  settings: unknown,
  options: ManagedClaudeHookOptions
): ManagedClaudeHookMutation {
  const events = uniqueEvents(options.events);
  const marker = managedMarker(options.marker);
  const cleaned = removeManagedClaudeHooks(settings, marker);
  const nextSettings: JsonRecord = { ...cleaned.settings };
  const hooks = { ...(asRecord(cleaned.settings.hooks) ?? {}) };
  let installed = 0;

  for (const eventName of events) {
    const command = options.commandForEvent(eventName).trim();
    if (!command || !command.includes(marker)) {
      throw new Error(`Managed Claude hook command for ${eventName} must include ${marker}`);
    }

    const hook: JsonRecord = { type: 'command', command };
    if (Number.isFinite(options.timeout) && Number(options.timeout) > 0) {
      hook.timeout = Math.floor(Number(options.timeout));
    }

    const group: JsonRecord = { hooks: [hook] };
    if (options.matcher !== undefined) {
      group.matcher = options.matcher;
    }

    const groups = Array.isArray(hooks[eventName]) ? [...hooks[eventName] as unknown[]] : [];
    groups.push(group);
    hooks[eventName] = groups;
    installed += 1;
  }

  nextSettings.hooks = hooks;
  return {
    settings: nextSettings,
    installed,
    removed: cleaned.removed
  };
}

export function getManagedClaudeHookStatus(
  settings: unknown,
  expectedEvents: readonly string[],
  marker?: string
): ManagedClaudeHookStatus {
  const hooks = asRecord(asRecord(settings)?.hooks) ?? {};
  const eventCounts: Record<string, number> = {};
  let managedCount = 0;

  for (const [eventName, groupsValue] of Object.entries(hooks)) {
    if (!Array.isArray(groupsValue)) {
      continue;
    }

    for (const groupValue of groupsValue) {
      const group = asRecord(groupValue);
      const hookList = Array.isArray(group?.hooks) ? group.hooks : [];
      const count = hookList.filter((hook) => isManagedClaudeHook(hook, marker)).length;
      if (count > 0) {
        eventCounts[eventName] = (eventCounts[eventName] ?? 0) + count;
        managedCount += count;
      }
    }
  }

  const expected = uniqueEvents(expectedEvents);
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
