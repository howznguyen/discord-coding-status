import { createHash } from 'crypto';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_USAGE_BETA = 'oauth-2025-04-20';

export type ClaudeCredentialSource = 'keychain' | 'file';
export type ClaudeQuotaMode =
  | 'auto'
  | 'subscription-oauth'
  | 'api-key'
  | 'environment-token'
  | 'custom-provider';

export interface ClaudeQuotaEligibility {
  eligible: boolean;
  reason: ClaudeQuotaUnavailableReason | null;
}

export interface ClaudeCredentialRotation {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[] | null;
}

export interface ClaudeCredentialStore {
  load(source: ClaudeCredentialSource): Promise<unknown | null>;
  persist(
    source: ClaudeCredentialSource,
    expectedGeneration: string,
    rotation: ClaudeCredentialRotation
  ): Promise<boolean>;
}

export interface ClaudeCredentialAdapter {
  read(): Promise<unknown | null>;
  write?(value: unknown): Promise<void>;
  compareAndSwap?(
    expectedGeneration: string,
    update: (currentValue: unknown) => unknown
  ): Promise<boolean>;
}

export interface ClaudeHttpRequest {
  url: typeof CLAUDE_USAGE_URL | typeof CLAUDE_REFRESH_URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  redirect: 'error';
}

export interface ClaudeHttpResponse {
  status: number;
  headers?: Headers | Record<string, string | string[] | undefined>;
  body?: unknown;
}

export type ClaudeHttpClient = (request: ClaudeHttpRequest) => Promise<ClaudeHttpResponse>;

export interface ClaudeQuotaWindow {
  remainingPercent: number;
  resetsAt: string | null;
}

export interface ClaudeQuotaSnapshot {
  planText: string | null;
  fiveHour: ClaudeQuotaWindow | null;
  sevenDay: ClaudeQuotaWindow | null;
  text: string;
  fetchedAt: number;
}

export type ClaudeQuotaUnavailableReason =
  | 'ineligible-api-key'
  | 'ineligible-environment-token'
  | 'ineligible-custom-provider'
  | 'credentials-unavailable'
  | 'missing-profile-scope'
  | 'authentication-failed'
  | 'credential-changed'
  | 'rate-limited'
  | 'transient-failure'
  | 'invalid-response';

export type ClaudeQuotaResult =
  | {
      status: 'fresh' | 'cached';
      quota: ClaudeQuotaSnapshot;
      source: ClaudeCredentialSource;
      reason: ClaudeQuotaUnavailableReason | null;
      diagnostic: string | null;
    }
  | {
      status: 'unavailable';
      quota: null;
      source: ClaudeCredentialSource | null;
      reason: ClaudeQuotaUnavailableReason;
      diagnostic: string;
    };

export interface ClaudeQuotaRequestOptions {
  mode?: ClaudeQuotaMode;
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface ClaudeQuotaEngineOptions {
  credentials: ClaudeCredentialStore;
  http: ClaudeHttpClient;
  now?: () => number;
  environment?: () => Readonly<Record<string, string | undefined>>;
  refreshIntervalMs?: number;
  defaultCooldownMs?: number;
  refreshBeforeExpiryMs?: number;
  oauthClientId?: string;
  userAgent?: string;
}

interface NormalizedClaudeCredential {
  source: ClaudeCredentialSource;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[] | null;
  planText: string | null;
  accountKey: string;
  generation: string;
  effectiveKey: string;
}

interface CandidateState {
  lastGood: ClaudeQuotaSnapshot | null;
  cooldownUntil: number;
}

interface CandidateAttempt {
  result: ClaudeQuotaResult;
  authFailure: boolean;
}

const CREDENTIAL_SOURCES: readonly ClaudeCredentialSource[] = ['keychain', 'file'];
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeExpiry(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed === null) {
    return null;
  }

  return parsed > 0 && parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
}

function oauthRecord(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value);
  if (!root) {
    return null;
  }

  return asRecord(root.claudeAiOauth)
    || asRecord(root.claude_ai_oauth)
    || asRecord(root.oauth)
    || root;
}

function scopeValues(record: Record<string, unknown>): string[] | null {
  const hasScopes = Object.prototype.hasOwnProperty.call(record, 'scopes')
    || Object.prototype.hasOwnProperty.call(record, 'scope');
  if (!hasScopes) {
    return null;
  }

  const raw = record.scopes ?? record.scope;
  const values = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/)
      : [];

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalCredentialValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalCredentialValue);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalCredentialValue(record[key])])
  );
}

function stableCredentialGeneration(value: unknown): string {
  return stableHash(JSON.stringify(canonicalCredentialValue(value)));
}

function jwtSubject(accessToken: string | null): string | null {
  if (!accessToken) {
    return null;
  }

  const parts = accessToken.split('.');
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = asRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    return stringValue(
      payload?.account_uuid
      ?? payload?.organization_uuid
      ?? payload?.sub
    );
  } catch (_) {
    return null;
  }
}

function formatPlanText(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }

  const known = raw.toLowerCase().replace(/^claude[-_\s]+/, '');
  if (['pro', 'max', 'team', 'enterprise', 'free'].includes(known)) {
    return `${known.charAt(0).toUpperCase()}${known.slice(1)}`;
  }

  return raw.replace(/\s+/g, ' ');
}

function normalizeCredential(
  source: ClaudeCredentialSource,
  value: unknown
): NormalizedClaudeCredential | null {
  const record = oauthRecord(value);
  if (!record) {
    return null;
  }

  const accessToken = stringValue(record.accessToken ?? record.access_token);
  const refreshToken = stringValue(record.refreshToken ?? record.refresh_token);
  if (!accessToken && !refreshToken) {
    return null;
  }

  const explicitAccount = stringValue(
    record.accountId
    ?? record.account_id
    ?? record.organizationUuid
    ?? record.organization_uuid
    ?? record.userId
    ?? record.user_id
  );
  const accountBasis = explicitAccount
    || jwtSubject(accessToken)
    || refreshToken
    || accessToken
    || 'unknown';
  const generation = stableCredentialGeneration(value);
  const accountKey = stableHash(`claude-account:${accountBasis}`);

  return {
    source,
    accessToken,
    refreshToken,
    expiresAt: normalizeExpiry(record.expiresAt ?? record.expires_at ?? record.expiration),
    scopes: scopeValues(record),
    planText: formatPlanText(
      record.subscriptionType
      ?? record.subscription_type
      ?? record.plan
      ?? record.rateLimitTier
      ?? record.rate_limit_tier
    ),
    accountKey,
    generation,
    effectiveKey: stableHash(`${source}:${accountKey}:${generation}`)
  };
}

export function claudeCredentialGeneration(value: unknown): string | null {
  const record = oauthRecord(value);
  return record ? stableCredentialGeneration(value) : null;
}

export function mergeClaudeCredentialRotation(
  value: unknown,
  rotation: ClaudeCredentialRotation
): unknown {
  const root = asRecord(value);
  if (!root) {
    return value;
  }

  const containerKey = asRecord(root.claudeAiOauth)
    ? 'claudeAiOauth'
    : asRecord(root.claude_ai_oauth)
      ? 'claude_ai_oauth'
      : asRecord(root.oauth)
        ? 'oauth'
        : null;
  const current = containerKey ? asRecord(root[containerKey]) || {} : root;
  const next: Record<string, unknown> = {
    ...current,
    accessToken: rotation.accessToken
  };

  if (rotation.refreshToken) {
    next.refreshToken = rotation.refreshToken;
  }
  if (rotation.expiresAt !== null) {
    next.expiresAt = rotation.expiresAt;
  }
  if (rotation.scopes !== null) {
    next.scopes = [...rotation.scopes];
  }

  if (!containerKey) {
    return next;
  }

  return {
    ...root,
    [containerKey]: next
  };
}

export function createClaudeCredentialStore(
  adapters: Partial<Record<ClaudeCredentialSource, ClaudeCredentialAdapter>>
): ClaudeCredentialStore {
  return {
    async load(source): Promise<unknown | null> {
      return adapters[source]?.read() ?? null;
    },
    async persist(source, expectedGeneration, rotation): Promise<boolean> {
      const adapter = adapters[source];
      if (!adapter) {
        return false;
      }

      const current = await adapter.read();
      if (claudeCredentialGeneration(current) !== expectedGeneration) {
        return false;
      }

      if (adapter.compareAndSwap) {
        return adapter.compareAndSwap(
          expectedGeneration,
          (currentValue) => mergeClaudeCredentialRotation(currentValue, rotation)
        );
      }
      if (!adapter.write) {
        return false;
      }

      const next = mergeClaudeCredentialRotation(current, rotation);
      await adapter.write(next);
      return true;
    }
  };
}

function truthyEnvironmentFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

export function evaluateClaudeQuotaEligibility(
  environment: Readonly<Record<string, string | undefined>>,
  mode: ClaudeQuotaMode = 'auto'
): ClaudeQuotaEligibility {
  if (mode === 'api-key') {
    return { eligible: false, reason: 'ineligible-api-key' };
  }
  if (mode === 'environment-token') {
    return { eligible: false, reason: 'ineligible-environment-token' };
  }
  if (mode === 'custom-provider') {
    return { eligible: false, reason: 'ineligible-custom-provider' };
  }
  if (mode === 'subscription-oauth') {
    return { eligible: true, reason: null };
  }

  if (stringValue(environment.ANTHROPIC_API_KEY)) {
    return { eligible: false, reason: 'ineligible-api-key' };
  }
  if (
    stringValue(environment.ANTHROPIC_AUTH_TOKEN)
    || stringValue(environment.CLAUDE_CODE_OAUTH_TOKEN)
  ) {
    return { eligible: false, reason: 'ineligible-environment-token' };
  }
  if (
    stringValue(environment.ANTHROPIC_BASE_URL)
    || truthyEnvironmentFlag(environment.CLAUDE_CODE_USE_BEDROCK)
    || truthyEnvironmentFlag(environment.CLAUDE_CODE_USE_VERTEX)
    || truthyEnvironmentFlag(environment.CLAUDE_CODE_USE_FOUNDRY)
    || truthyEnvironmentFlag(environment.CLAUDE_CODE_USE_MANTLE)
    || truthyEnvironmentFlag(environment.CLAUDE_CODE_USE_ANTHROPIC_AWS)
  ) {
    return { eligible: false, reason: 'ineligible-custom-provider' };
  }

  return { eligible: true, reason: null };
}

function percentageRemaining(value: unknown): number | null {
  const utilization = numberValue(value);
  if (utilization === null) {
    return null;
  }

  return Math.round(Math.max(0, Math.min(100, 100 - utilization)) * 10) / 10;
}

function quotaWindow(value: unknown): ClaudeQuotaWindow | null {
  const record = asRecord(value);
  const remainingPercent = percentageRemaining(record?.utilization);
  if (!record || remainingPercent === null) {
    return null;
  }

  const resetValue = record.resets_at ?? record.resetsAt;
  return {
    remainingPercent,
    resetsAt: typeof resetValue === 'string' || typeof resetValue === 'number'
      ? String(resetValue)
      : null
  };
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatClaudeQuota(snapshot: {
  planText?: string | null;
  fiveHour?: ClaudeQuotaWindow | null;
  sevenDay?: ClaudeQuotaWindow | null;
}): string {
  const parts: string[] = [];
  const planText = formatPlanText(snapshot.planText);
  if (planText) {
    parts.push(planText);
  }
  if (snapshot.fiveHour) {
    parts.push(`5h ${formatPercentage(snapshot.fiveHour.remainingPercent)}%`);
  }
  if (snapshot.sevenDay) {
    parts.push(`weekly ${formatPercentage(snapshot.sevenDay.remainingPercent)}%`);
  }
  return parts.join(' • ');
}

function quotaFromUsage(
  value: unknown,
  credential: NormalizedClaudeCredential,
  fetchedAt: number
): ClaudeQuotaSnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const fiveHour = quotaWindow(record.five_hour ?? record.fiveHour);
  const sevenDay = quotaWindow(record.seven_day ?? record.sevenDay);
  const planText = formatPlanText(
    record.plan
    ?? record.subscription_type
    ?? record.subscriptionType
    ?? credential.planText
  );
  const text = formatClaudeQuota({ planText, fiveHour, sevenDay });
  if (!text || (!fiveHour && !sevenDay)) {
    return null;
  }

  return { planText, fiveHour, sevenDay, text, fetchedAt };
}

function headerValue(
  headers: ClaudeHttpResponse['headers'],
  name: string
): string | null {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }

  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== expected) {
      continue;
    }
    return Array.isArray(value) ? value[0] || null : value || null;
  }
  return null;
}

function retryAfterTimestamp(
  response: ClaudeHttpResponse,
  now: number,
  fallbackMs: number
): number {
  const raw = headerValue(response.headers, 'retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return now + seconds * 1_000;
    }

    const date = Date.parse(raw);
    if (Number.isFinite(date) && date > now) {
      return date;
    }
  }

  return now + fallbackMs;
}

function successStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function authStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function diagnosticFor(reason: ClaudeQuotaUnavailableReason): string {
  const diagnostics: Record<ClaudeQuotaUnavailableReason, string> = {
    'ineligible-api-key': 'Claude quota is hidden while Anthropic API-key mode is active.',
    'ineligible-environment-token': 'Claude quota is hidden while an environment credential is active.',
    'ineligible-custom-provider': 'Claude quota is hidden while a custom Claude provider is active.',
    'credentials-unavailable': 'Claude subscription OAuth credentials are unavailable.',
    'missing-profile-scope': 'Claude OAuth is missing the user:profile scope; sign in again with Claude Code.',
    'authentication-failed': 'Claude subscription OAuth authentication failed; sign in again with Claude Code.',
    'credential-changed': 'Claude login changed while quota was refreshing; retry with the current login.',
    'rate-limited': 'Claude quota is temporarily rate limited; retry after the cooldown.',
    'transient-failure': 'Claude quota is temporarily unavailable; the daemon will retry.',
    'invalid-response': 'Claude returned an unsupported quota response.'
  };
  return diagnostics[reason];
}

function unavailable(
  reason: ClaudeQuotaUnavailableReason,
  source: ClaudeCredentialSource | null = null
): ClaudeQuotaResult {
  return {
    status: 'unavailable',
    quota: null,
    source,
    reason,
    diagnostic: diagnosticFor(reason)
  };
}

export function createFetchClaudeHttpClient(
  fetchImpl: typeof fetch = fetch
): ClaudeHttpClient {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.redirect
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch (_) {
      // Status handling does not require a response body.
    }

    return {
      status: response.status,
      headers: response.headers,
      body
    };
  };
}

export class ClaudeQuotaEngine {
  private readonly credentials: ClaudeCredentialStore;
  private readonly http: ClaudeHttpClient;
  private readonly now: () => number;
  private readonly environment: () => Readonly<Record<string, string | undefined>>;
  private readonly refreshIntervalMs: number;
  private readonly defaultCooldownMs: number;
  private readonly refreshBeforeExpiryMs: number;
  private readonly oauthClientId: string;
  private readonly userAgent: string;
  private readonly states = new Map<string, CandidateState>();
  private readonly inFlight = new Map<string, Promise<CandidateAttempt>>();
  private observedCredentialSet: string | null = null;
  private lastEffectiveKey: string | null = null;

  constructor(options: ClaudeQuotaEngineOptions) {
    this.credentials = options.credentials;
    this.http = options.http;
    this.now = options.now || Date.now;
    this.environment = options.environment || (() => process.env);
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.refreshBeforeExpiryMs = options.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
    this.oauthClientId = options.oauthClientId || CLAUDE_CODE_OAUTH_CLIENT_ID;
    this.userAgent = options.userAgent || 'claude-code';
  }

  clear(): void {
    this.states.clear();
    this.inFlight.clear();
    this.observedCredentialSet = null;
    this.lastEffectiveKey = null;
  }

  async getQuota(options: ClaudeQuotaRequestOptions = {}): Promise<ClaudeQuotaResult> {
    const eligibility = evaluateClaudeQuotaEligibility(
      options.environment || this.environment(),
      options.mode || 'auto'
    );
    if (!eligibility.eligible) {
      return unavailable(eligibility.reason || 'ineligible-custom-provider');
    }

    const candidates = await this.loadCandidates();
    if (candidates.length === 0) {
      this.resetForCredentialSet(null);
      return unavailable('credentials-unavailable');
    }

    this.syncCredentialSet(candidates);
    const preferred = this.lastEffectiveKey
      ? candidates.find((candidate) => candidate.effectiveKey === this.lastEffectiveKey)
      : null;
    if (preferred) {
      const cached = this.cachedResult(preferred);
      if (cached) {
        return cached;
      }
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const attempt = await this.coalescedAttempt(candidate, candidates);
      if (attempt.result.status !== 'unavailable') {
        this.lastEffectiveKey = candidate.effectiveKey;
        return attempt.result;
      }

      const mayFallback = candidate.source === 'keychain'
        && attempt.authFailure
        && candidates.slice(index + 1).some((item) => item.source === 'file');
      if (!mayFallback) {
        return attempt.result;
      }
    }

    return unavailable('authentication-failed');
  }

  private async loadCandidates(): Promise<NormalizedClaudeCredential[]> {
    const values = await Promise.all(CREDENTIAL_SOURCES.map(async (source) => ({
      source,
      value: await this.credentials.load(source)
    })));

    return values
      .map(({ source, value }) => normalizeCredential(source, value))
      .filter((candidate): candidate is NormalizedClaudeCredential => Boolean(candidate));
  }

  private resetForCredentialSet(next: string | null): void {
    if (this.observedCredentialSet !== null && this.observedCredentialSet !== next) {
      this.states.clear();
      this.lastEffectiveKey = null;
    }
    this.observedCredentialSet = next;
  }

  private syncCredentialSet(candidates: NormalizedClaudeCredential[]): void {
    const next = this.credentialSetFingerprint(candidates);
    this.resetForCredentialSet(next);
  }

  private credentialSetFingerprint(candidates: NormalizedClaudeCredential[]): string {
    return stableHash(candidates.map((candidate) => (
      `${candidate.source}:${candidate.generation}`
    )).join('|'));
  }

  private cachedResult(candidate: NormalizedClaudeCredential): ClaudeQuotaResult | null {
    const state = this.states.get(candidate.effectiveKey);
    if (!state) {
      return null;
    }

    const now = this.now();
    if (state.cooldownUntil > now) {
      return state.lastGood
        ? {
            status: 'cached',
            quota: state.lastGood,
            source: candidate.source,
            reason: 'rate-limited',
            diagnostic: diagnosticFor('rate-limited')
          }
        : unavailable('rate-limited', candidate.source);
    }
    if (state.lastGood && now - state.lastGood.fetchedAt < this.refreshIntervalMs) {
      return {
        status: 'cached',
        quota: state.lastGood,
        source: candidate.source,
        reason: null,
        diagnostic: null
      };
    }

    return null;
  }

  private coalescedAttempt(
    candidate: NormalizedClaudeCredential,
    candidates: NormalizedClaudeCredential[]
  ): Promise<CandidateAttempt> {
    const pending = this.inFlight.get(candidate.effectiveKey);
    if (pending) {
      return pending;
    }

    const attempt = this.attemptCandidate(candidate, candidates)
      .finally(() => this.inFlight.delete(candidate.effectiveKey));
    this.inFlight.set(candidate.effectiveKey, attempt);
    return attempt;
  }

  private async attemptCandidate(
    candidate: NormalizedClaudeCredential,
    candidates: NormalizedClaudeCredential[]
  ): Promise<CandidateAttempt> {
    const cached = this.cachedResult(candidate);
    if (cached) {
      return { result: cached, authFailure: false };
    }

    if (candidate.scopes !== null && !candidate.scopes.includes('user:profile')) {
      return {
        result: unavailable('missing-profile-scope', candidate.source),
        authFailure: false
      };
    }

    let active = candidate;
    if (
      active.expiresAt !== null
      && active.expiresAt <= this.now() + this.refreshBeforeExpiryMs
    ) {
      const refreshed = await this.refreshCredential(active, candidates);
      if ('result' in refreshed) {
        return refreshed;
      }
      active = refreshed.candidate;
    }

    let response: ClaudeHttpResponse;
    try {
      response = await this.fetchUsage(active.accessToken);
    } catch (_) {
      return this.transientResult(active, 'transient-failure');
    }

    if (authStatus(response.status) && active.refreshToken) {
      const refreshed = await this.refreshCredential(active, candidates);
      if ('result' in refreshed) {
        return refreshed;
      }
      active = refreshed.candidate;

      try {
        response = await this.fetchUsage(active.accessToken);
      } catch (_) {
        return this.transientResult(active, 'transient-failure');
      }
    }

    if (authStatus(response.status)) {
      return {
        result: unavailable('authentication-failed', active.source),
        authFailure: true
      };
    }
    if (response.status === 429) {
      const state = this.stateFor(active);
      state.cooldownUntil = retryAfterTimestamp(response, this.now(), this.defaultCooldownMs);
      return this.transientResult(active, 'rate-limited');
    }
    if (response.status >= 500) {
      return this.transientResult(active, 'transient-failure');
    }
    if (!successStatus(response.status)) {
      return {
        result: unavailable('invalid-response', active.source),
        authFailure: false
      };
    }

    const snapshot = quotaFromUsage(response.body, active, this.now());
    if (!snapshot) {
      return {
        result: unavailable('invalid-response', active.source),
        authFailure: false
      };
    }

    const currentCandidates = await this.loadCandidates();
    const current = currentCandidates.find((item) => item.source === active.source);
    const credentialSetChanged = this.observedCredentialSet !== this.credentialSetFingerprint(
      currentCandidates
    );
    if (!current || current.generation !== active.generation || credentialSetChanged) {
      this.states.clear();
      this.lastEffectiveKey = null;
      return {
        result: unavailable('credential-changed', active.source),
        authFailure: false
      };
    }

    const state = this.stateFor(active);
    state.lastGood = snapshot;
    state.cooldownUntil = 0;
    return {
      result: {
        status: 'fresh',
        quota: snapshot,
        source: active.source,
        reason: null,
        diagnostic: null
      },
      authFailure: false
    };
  }

  private async refreshCredential(
    candidate: NormalizedClaudeCredential,
    candidates: NormalizedClaudeCredential[]
  ): Promise<{ candidate: NormalizedClaudeCredential } | CandidateAttempt> {
    if (!candidate.refreshToken) {
      return {
        result: unavailable('authentication-failed', candidate.source),
        authFailure: true
      };
    }

    let response: ClaudeHttpResponse;
    try {
      response = await this.http({
        url: CLAUDE_REFRESH_URL,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: candidate.refreshToken,
          client_id: this.oauthClientId
        }),
        redirect: 'error'
      });
    } catch (_) {
      return this.transientResult(candidate, 'transient-failure');
    }

    if (authStatus(response.status) || response.status === 400) {
      return {
        result: unavailable('authentication-failed', candidate.source),
        authFailure: true
      };
    }
    if (response.status === 429) {
      const state = this.stateFor(candidate);
      state.cooldownUntil = retryAfterTimestamp(response, this.now(), this.defaultCooldownMs);
      return this.transientResult(candidate, 'rate-limited');
    }
    if (response.status >= 500 || !successStatus(response.status)) {
      return this.transientResult(candidate, 'transient-failure');
    }

    const body = asRecord(response.body);
    const accessToken = stringValue(body?.access_token ?? body?.accessToken);
    if (!accessToken) {
      return {
        result: unavailable('invalid-response', candidate.source),
        authFailure: false
      };
    }

    const expiresIn = numberValue(body?.expires_in ?? body?.expiresIn);
    const explicitExpiry = normalizeExpiry(body?.expires_at ?? body?.expiresAt);
    const rotation: ClaudeCredentialRotation = {
      accessToken,
      refreshToken: stringValue(body?.refresh_token ?? body?.refreshToken) || candidate.refreshToken,
      expiresAt: explicitExpiry ?? (expiresIn === null ? null : this.now() + expiresIn * 1_000),
      scopes: body && (Object.prototype.hasOwnProperty.call(body, 'scope')
        || Object.prototype.hasOwnProperty.call(body, 'scopes'))
        ? scopeValues(body)
        : candidate.scopes
    };

    let persisted = false;
    try {
      persisted = await this.credentials.persist(
        candidate.source,
        candidate.generation,
        rotation
      );
    } catch (_) {
      return this.transientResult(candidate, 'transient-failure');
    }
    if (!persisted) {
      this.states.clear();
      this.lastEffectiveKey = null;
      return {
        result: unavailable('credential-changed', candidate.source),
        authFailure: false
      };
    }

    const current = normalizeCredential(candidate.source, await this.credentials.load(candidate.source));
    if (!current || current.accessToken !== rotation.accessToken) {
      this.states.clear();
      this.lastEffectiveKey = null;
      return {
        result: unavailable('credential-changed', candidate.source),
        authFailure: false
      };
    }

    const updatedCandidates = candidates.map((item) => (
      item.source === candidate.source ? current : item
    ));
    this.syncCredentialSet(updatedCandidates);
    return { candidate: current };
  }

  private fetchUsage(accessToken: string | null): Promise<ClaudeHttpResponse> {
    if (!accessToken) {
      return Promise.resolve({ status: 401 });
    }

    return this.http({
      url: CLAUDE_USAGE_URL,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': this.userAgent,
        'anthropic-beta': CLAUDE_USAGE_BETA
      },
      redirect: 'error'
    });
  }

  private stateFor(candidate: NormalizedClaudeCredential): CandidateState {
    const existing = this.states.get(candidate.effectiveKey);
    if (existing) {
      return existing;
    }

    const state: CandidateState = { lastGood: null, cooldownUntil: 0 };
    this.states.set(candidate.effectiveKey, state);
    return state;
  }

  private transientResult(
    candidate: NormalizedClaudeCredential,
    reason: 'rate-limited' | 'transient-failure'
  ): CandidateAttempt {
    const lastGood = this.stateFor(candidate).lastGood;
    if (!lastGood) {
      return {
        result: unavailable(reason, candidate.source),
        authFailure: false
      };
    }

    return {
      result: {
        status: 'cached',
        quota: lastGood,
        source: candidate.source,
        reason,
        diagnostic: diagnosticFor(reason)
      },
      authFailure: false
    };
  }
}
