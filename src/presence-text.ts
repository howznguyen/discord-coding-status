'use strict';

import * as path from 'node:path';
import {
  MAX_PRESENCE_TEXT_LENGTH,
  ACTIVITY_STYLE,
  PLAN_TEXT_OVERRIDE,
  LIMITS_TEXT_OVERRIDE,
  DETAIL_LEVEL,
  extractString,
  asRecord
} from './env';
import type { ActivityStyle } from './commands/config/types';
import type { RichStateParts } from './core/presence/types';
import type { CodexQuotaSnapshot, CodexQuotaWindow } from './core/quota/types';
import type { ActiveTool } from './core/tools/types';

const STATUS_EMOJI: Record<string, string> = {
  active: '⚡',
  running: '⚡',
  thinking: '🧠',
  streaming: '✨',
  waiting: '⏳',
  waiting_input: '✋',
  waiting_approval: '🛂',
  idle: '💤',
  paused: '⏸️',
  error: '🐛'
};

const DEFAULT_STATUS_EMOJI = '👾';

function emojiForStatus(value: string | null | undefined): string | null {
  const normalized = normalizeStatus(value);
  return STATUS_EMOJI[normalized] || DEFAULT_STATUS_EMOJI;
}

const STATUS_MESSAGES: Record<string, string[]> = {
  active: [
    'Vibing responsibly',
    'Shipping confidence',
    'Turning coffee into diffs',
    'Pretending this was planned',
    'Debugging with main character energy',
    'Making the repo look employed',
    'Asking AI nicely',
    'Keeping the syntax hydrated',
    'Pushing pixels and promises',
    'Building features with suspicious calm'
  ],
  running: [
    'Cooking tokens',
    'Negotiating with TypeScript',
    'Letting the model cook',
    'Running on caffeine and context',
    'Producing a diff with legal tender energy',
    'Trying not to invent a framework',
    'Compiling brave ideas',
    'Refactoring reality',
    'Making localhost feel important',
    'Convincing tests to be reasonable'
  ],
  thinking: [
    'Overthinking professionally',
    'Staring at context like it owes money',
    'Calculating semicolon risk',
    'Reading the repo before touching it',
    'Consulting the inner stack trace',
    'Finding the least dramatic fix',
    'Measuring twice, patching once',
    'Profiling the vibes',
    'Waiting for the obvious answer to arrive',
    'Doing senior-engineer silence'
  ],
  streaming: [
    'Typing with confidence',
    'Generating tasteful chaos',
    'Printing tokens with intent',
    'Turning prompts into receipts',
    'Writing code at conversational speed',
    'Letting the cursor sprint',
    'Autocompleting destiny',
    'Making stdout earn rent',
    'Delivering the diff live',
    'Streaming probable solutions'
  ],
  waiting: [
    'Waiting dramatically',
    'Holding the cursor hostage',
    'Standing by with a clean diff',
    'Ready for the next brilliant demand',
    'Waiting like CI on a Friday',
    'Keeping the prompt warm',
    'Paused at the edge of greatness',
    'Letting the user cook',
    'Maintaining professional suspense',
    'Idle but emotionally available'
  ],
  waiting_input: [
    'Your move, captain',
    'Awaiting the next plot twist',
    'Waiting for instructions with posture',
    'The prompt ball is on your side',
    'Ready when the keyboard is',
    'Standing by for fresh context',
    'Holding position at line zero',
    'Waiting for a very important sentence',
    'Input requested, confidence preserved',
    'One more prompt from greatness'
  ],
  waiting_approval: [
    'Needs a permission slip',
    'Waiting for the adult in the room',
    'Asking before touching the sharp tools',
    'Permission gate doing permission things',
    'Awaiting the sacred yes',
    'Paused at the policy checkpoint',
    'Holding the risky command politely',
    'Needs a nod before the diff party',
    'Approval pending, hands visible',
    'Standing outside sudo with respect'
  ],
  idle: [
    'On a tiny coffee break',
    'Resting the context window',
    'Idle, but still judging tabs',
    'Saving tokens for something dramatic',
    'Taking a compile-length breath',
    'Not frozen, just minimalist',
    'Charging the next idea',
    'Quietly not breaking production',
    'Letting the repo cool down',
    'Practicing restraint'
  ],
  paused: [
    'Paused mid-genius',
    'Suspended between two better ideas',
    'Parking the brain process',
    'Holding that thought in RAM',
    'Paused for dramatic indentation',
    'Keeping the half-diff fresh',
    'Waiting for the next commit arc',
    'Temporarily not making things worse',
    'Break-pointing real life',
    'Paused with intent'
  ],
  error: [
    'Tripped on a semicolon',
    'Currently negotiating with failure',
    'The stack trace has opinions',
    'Something yelled in red',
    'Reality returned non-zero',
    'Bug found, ego patched',
    'The happy path filed a complaint',
    'Unhandled ambition detected',
    'Compiler said no with confidence',
    'Debugging the emotional damage'
  ]
};

const TERMINAL_STATUSES = new Set([
  'done',
  'complete',
  'completed',
  'stopped',
  'exited',
  'closed',
  'clear',
  'cleared'
]);

function truncatePresenceText(value: string | null | undefined): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  if (text.length <= MAX_PRESENCE_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_PRESENCE_TEXT_LENGTH - 3)}...`;
}

function sanitizeProjectName(value: string | null | undefined): string | null {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const basename = path.basename(text);
  const cleaned = basename
    .replace(/[^\w .@-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || ['/', '.', 'contents', 'resources', 'macos'].includes(cleaned.toLowerCase())) {
    return null;
  }

  return truncatePresenceText(cleaned);
}

function sanitizePackageName(value: string | null | undefined): string | null {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return null;
  }

  return truncatePresenceText(text.replace(/[^\w .@/-]/g, ''));
}

function formatContextText(value: string | null | undefined): string | null {
  const text = String(value || '')
    .replace(/^(?:ctx|context)\s*[:=]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return null;
  }

  const amount = '\\d+(?:\\.\\d+)?(?:%|[kKmMbB]?(?:\\s*(?:tok|tokens?))?)';
  const metricPattern = new RegExp(`^${amount}(?:\\s*\\/\\s*${amount})?$`, 'i');
  if (!metricPattern.test(text)) {
    return null;
  }

  return truncatePresenceText(`ctx ${text}`);
}

function sanitizeBranchName(value: string | null | undefined): string | null {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const cleaned = text
    .replace(/[^\w./@+-]/g, '')
    .replace(/^refs\/heads\//, '')
    .trim();

  return cleaned ? truncatePresenceText(cleaned) : null;
}

function joinPresenceParts(parts: Array<string | null | undefined>): string {
  return truncatePresenceText(parts.filter(Boolean).join(' | '));
}

function joinMetricParts(parts: Array<string | null | undefined>): string {
  return truncatePresenceText(parts.filter(Boolean).join(' • '));
}

function formatDollar(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return `$${value.toFixed(2)}`;
}

function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B tok`;
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M tok`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K tok`;
  }

  return `${Math.round(value)} tok`;
}

function capitalizeWord(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function normalizeStatus(value: string | null | undefined): string {
  return String(value || 'active').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash);
}

function pickTimedMessage(key: string, messages: string[]): string {
  if (!messages.length) {
    return '';
  }

  const tenMinuteBucket = Math.floor(Date.now() / (10 * 60_000));
  return messages[hashString(`${key}:${tenMinuteBucket}`) % messages.length];
}

function statusLabel(value: string | null | undefined): string | null {
  const normalized = normalizeStatus(value);
  const known = STATUS_MESSAGES[normalized];

  if (known) {
    return pickTimedMessage(normalized, known);
  }

  const cleaned = normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  return cleaned || null;
}

function styledStatusLabel(
  value: string | null | undefined,
  style: ActivityStyle = ACTIVITY_STYLE
): string | null {
  if (style === 'fun') {
    return statusLabel(value);
  }

  const normalized = normalizeStatus(value);
  if (style === 'minimal') {
    if (normalized === 'thinking') {
      return 'Thinking';
    }
    if (['waiting', 'waiting_input', 'waiting_approval'].includes(normalized)) {
      return 'Waiting';
    }
    if (['idle', 'paused'].includes(normalized)) {
      return 'Idle';
    }
    if (normalized === 'error') {
      return 'Error';
    }
    return 'Working';
  }

  const labels: Record<string, string> = style === 'technical'
    ? {
        active: 'Active session',
        running: 'Running',
        thinking: 'Model thinking',
        streaming: 'Streaming output',
        waiting: 'Waiting',
        waiting_input: 'Waiting for input',
        waiting_approval: 'Permission requested',
        idle: 'Session idle',
        paused: 'Session paused',
        error: 'Session error'
      }
    : {
        active: 'Working',
        running: 'Working',
        thinking: 'Thinking',
        streaming: 'Writing a response',
        waiting: 'Waiting',
        waiting_input: 'Waiting for input',
        waiting_approval: 'Waiting for approval',
        idle: 'Idle',
        paused: 'Paused',
        error: 'Handling an error'
      };

  return labels[normalized] || statusLabel(value);
}

function isTerminalStatus(value: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(value));
}

function formatWindowMinutes(minutes: number | null | undefined): string {
  if (!minutes || !Number.isFinite(minutes)) {
    return 'window';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)}h`;
  }

  if (minutes === 10080) {
    return 'weekly';
  }

  return `${Math.round(minutes / 1440)}d`;
}

function formatUsageWindow(label: string, window: unknown): string | null {
  if (!window || typeof window !== 'object') {
    return null;
  }

  const data = window as {
    usedPercent?: unknown;
    windowMinutes?: unknown;
    resetDescription?: unknown;
  };

  if (typeof data.usedPercent !== 'number') {
    return null;
  }

  const windowLabel = label || formatWindowMinutes(
    typeof data.windowMinutes === 'number' ? data.windowMinutes : null
  );
  const remainingPercent = Math.max(0, Math.min(100, 100 - data.usedPercent));

  return `${windowLabel} ${Math.round(remainingPercent)}%`;
}

function formatCodexPlanText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return titleCase(value
    .replace(/^chatgpt[_-]/i, '')
    .replace(/\s*\(\$[^)]*\)/g, '')
    .replace(/[_-]+/g, ' '))
    .replace(/\bX(\d)/g, 'x$1');
}

function formatCodexMultiplierText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return `x${Number.isInteger(value) ? value : value.toFixed(1)}`;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const text = value.trim();
  const match = text.match(/(?:^|[\s_-])x?(\d+(?:\.\d+)?)(?:x)?(?:$|[\s_-])/i);
  if (!match) {
    return null;
  }

  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 1) {
    return null;
  }

  return `x${Number.isInteger(number) ? number : number.toFixed(1)}`;
}

function formatCodexCredits(value: number | null): string | null {
  if (value === null) {
    return null;
  }

  return `credits ${value.toFixed(value % 1 === 0 ? 0 : 1)}`;
}

function formatRichStateText(parts: RichStateParts): string | null {
  const text = joinMetricParts([
    parts.planText,
    parts.limitsText
  ]);

  return text || null;
}

function richStateFromCodexSnapshot(snapshot: CodexQuotaSnapshot, tool?: ActiveTool): RichStateParts {
  const windowTexts = [snapshot.primary, snapshot.secondary]
    .filter((window): window is CodexQuotaWindow => window !== null)
    .sort((left, right) => (left.windowMinutes ?? Number.POSITIVE_INFINITY)
      - (right.windowMinutes ?? Number.POSITIVE_INFINITY))
    .map((window) => formatUsageWindow('', window))
    .filter((text): text is string => text !== null);
  const limitsText = LIMITS_TEXT_OVERRIDE || joinMetricParts([
    ...windowTexts,
    windowTexts.length === 0 ? formatCodexCredits(snapshot.creditsRemaining) : null
  ]);

  return {
    planText: PLAN_TEXT_OVERRIDE || snapshot.planText,
    limitsText
  };
}

function richStateFromRecord(record: Record<string, unknown>, tool?: ActiveTool): RichStateParts {
  const plan = extractString(record.planText ?? record.plan_text ?? record.plan ?? record.planName ?? record.plan_name ?? record.planType ?? record.plan_type);
  const limits = extractString(record.limitsText ?? record.limits_text ?? record.limits ?? record.quota ?? record.quotaText ?? record.quota_text);

  return {
    planText: PLAN_TEXT_OVERRIDE || formatCodexPlanText(plan) || plan,
    limitsText: LIMITS_TEXT_OVERRIDE || (limits ? truncatePresenceText(limits) : null)
  };
}

function parseRichStateCommandOutput(output: string, tool?: ActiveTool): string | null {
  const text = output.trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    if (record) {
      return formatRichStateText(richStateFromRecord(record, tool));
    }
  } catch (_) {
    // Plain text command output is still supported.
  }

  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine ? truncatePresenceText(firstLine) : null;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function surfaceLabel(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'cli') {
    return 'CLI';
  }

  if (normalized === 'app') {
    return 'App';
  }

  return titleCase(normalized || 'Session');
}

function statePriority(status: string): number {
  const normalized = normalizeStatus(status);

  if (normalized === 'waiting_approval') {
    return 100;
  }

  if (['running', 'thinking', 'streaming', 'active'].includes(normalized)) {
    return 80;
  }

  if (['waiting_input', 'waiting'].includes(normalized)) {
    return 60;
  }

  if (['idle', 'paused'].includes(normalized)) {
    return 20;
  }

  return 40;
}

function sessionDetails(activity: string | undefined, fallback: string): string {
  return DETAIL_LEVEL === 'full' && activity ? activity : fallback;
}

export {
  STATUS_MESSAGES,
  STATUS_EMOJI,
  DEFAULT_STATUS_EMOJI,
  emojiForStatus,
  TERMINAL_STATUSES,
  pickTimedMessage,
  hashString,
  normalizeStatus,
  statusLabel,
  styledStatusLabel,
  isTerminalStatus,
  truncatePresenceText,
  sanitizeProjectName,
  sanitizePackageName,
  formatContextText,
  sanitizeBranchName,
  joinPresenceParts,
  joinMetricParts,
  formatDollar,
  formatTokenCount,
  capitalizeWord,
  titleCase,
  surfaceLabel,
  statePriority,
  sessionDetails,
  formatWindowMinutes,
  formatUsageWindow,
  formatCodexPlanText,
  formatCodexMultiplierText,
  formatCodexCredits,
  formatRichStateText,
  richStateFromCodexSnapshot,
  richStateFromRecord,
  parseRichStateCommandOutput
};
