import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_ID,
  CLAUDE_CREDENTIALS_FILE,
  CLAUDE_KEYCHAIN_SERVICE,
  CODEX_API_BASE_URL,
  CODEX_AUTH_FILE,
  CODEX_BIN,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_QUOTA_SOURCE,
  PLAN_TEXT_OVERRIDE,
  SHOW_QUOTA,
  USAGE_COMMAND,
  USAGE_REFRESH_INTERVAL_MS,
  USAGE_TEXT,
  USAGE_TIMEOUT_MS,
  VERSION,
  asRecord,
  extractNumberLike,
  extractString,
  logError
} from './env';
import {
  formatCodexMultiplierText,
  formatCodexPlanText,
  formatRichStateText,
  joinMetricParts,
  parseRichStateCommandOutput,
  richStateFromCodexSnapshot,
  truncatePresenceText
} from './presence-text';
import { envValue } from './commands/config/settings';
import {
  claudeQuotaRequestOptions,
  debugLog,
  log
} from './state-store';
import {
  ClaudeQuotaEngine,
  claudeCredentialGeneration,
  createClaudeCredentialStore,
  createFetchClaudeHttpClient
} from './claude-quota';
import type {
  CodexOAuthCredentials,
  CodexQuotaSnapshot,
  CodexQuotaSource,
  CodexQuotaWindow,
  PendingJsonRpcRequest
} from './core/quota/types';
import type { RichStateParts } from './core/presence/types';
import type { ActiveTool, ToolFamily } from './core/tools/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const cachedUsageTextByKey = new Map<string, { text: string | null; fetchedAt: number }>();
export const usageRefreshesByKey = new Map<string, Promise<void>>();
export const claudeUsageRevisionBySession = new Map<string, number>();

export function shouldShowUsage(): boolean {
  return SHOW_QUOTA;
}

export function toolFamilyForTool(tool: ActiveTool | null | undefined): ToolFamily {
  if (!tool) {
    return 'other';
  }

  if (tool.family) {
    return tool.family;
  }

  const text = [tool.key, tool.details, tool.state]
    .join(' ')
    .toLowerCase();

  if (text.includes('claude')) {
    return 'claude';
  }

  if (text.includes('codex')) {
    return 'codex';
  }

  if (text.includes('grok')) {
    return 'grok';
  }

  if (text.includes('opencode')) {
    return 'opencode';
  }

  if (text.includes('cursor')) {
    return 'cursor';
  }

  if (text.includes('pi')) {
    return 'pi';
  }

  return 'other';
}

function isCodexTool(tool: ActiveTool | null | undefined): boolean {
  return toolFamilyForTool(tool) === 'codex';
}

function codexUsageUrl(pathname: string): string {
  return `${CODEX_API_BASE_URL}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function extractCodexPlanText(...records: Array<Record<string, unknown> | null | undefined>): string | null {
  const planKeys = [
    'planText',
    'plan_text',
    'planName',
    'plan_name',
    'plan',
    'planType',
    'plan_type',
    'chatgptPlanType',
    'chatgpt_plan_type',
    'subscriptionPlan',
    'subscription_plan',
    'subscriptionTier',
    'subscription_tier',
    'rateLimitTier',
    'rate_limit_tier',
    'usageTier',
    'usage_tier',
    'tier'
  ];
  const multiplierKeys = [
    'multiplier',
    'quotaMultiplier',
    'quota_multiplier',
    'rateLimitMultiplier',
    'rate_limit_multiplier',
    'usageMultiplier',
    'usage_multiplier',
    'codexMultiplier',
    'codex_multiplier'
  ];
  let planText: string | null = null;
  let multiplierText: string | null = null;

  for (const record of records) {
    if (!record) {
      continue;
    }

    if (!planText) {
      for (const key of planKeys) {
        planText = formatCodexPlanText(extractString(record[key]));
        if (planText) {
          break;
        }
      }
    }

    if (!multiplierText) {
      for (const key of multiplierKeys) {
        multiplierText = formatCodexMultiplierText(record[key]);
        if (multiplierText) {
          break;
        }
      }
    }
  }

  if (planText && multiplierText && !planText.toLowerCase().includes(multiplierText.toLowerCase())) {
    return `${planText} ${multiplierText}`;
  }

  return planText || multiplierText;
}

function codexQuotaWindowFromRecord(value: unknown): CodexQuotaWindow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const usedPercent = extractNumberLike(record.usedPercent ?? record.used_percent);
  if (usedPercent === null) {
    return null;
  }

  const explicitMinutes = extractNumberLike(
    record.windowMinutes
      ?? record.window_duration_mins
      ?? record.windowDurationMins
  );
  const seconds = extractNumberLike(
    record.limit_window_seconds
      ?? record.limitWindowSeconds
  );
  const windowMinutes = explicitMinutes !== null
    ? explicitMinutes
    : (seconds === null ? null : seconds / 60);

  return {
    usedPercent,
    windowMinutes
  };
}

function codexQuotaFromRpcResult(result: unknown): CodexQuotaSnapshot | null {
  const payload = asRecord(result);
  const rateLimits = asRecord(payload?.rateLimits ?? payload?.rate_limits) || payload;
  if (!rateLimits) {
    return null;
  }

  const credits = asRecord(rateLimits.credits);
  const planText = extractCodexPlanText(payload, rateLimits, credits);
  const primary = codexQuotaWindowFromRecord(rateLimits.primary ?? rateLimits.primary_window);
  const secondary = codexQuotaWindowFromRecord(rateLimits.secondary ?? rateLimits.secondary_window);
  const creditsRemaining = extractNumberLike(credits?.balance);

  if (!planText && !primary && !secondary && creditsRemaining === null) {
    return null;
  }

  return {
    source: 'codex-rpc',
    planText,
    primary,
    secondary,
    creditsRemaining
  };
}

function codexQuotaFromUsageResponse(payload: unknown): CodexQuotaSnapshot | null {
  const response = asRecord(payload);
  if (!response) {
    return null;
  }

  const rateLimit = asRecord(response.rate_limit ?? response.rateLimit) || response;
  const credits = asRecord(response.credits);
  const planText = extractCodexPlanText(response, rateLimit, credits);
  const primary = codexQuotaWindowFromRecord(rateLimit.primary_window ?? rateLimit.primary);
  const secondary = codexQuotaWindowFromRecord(rateLimit.secondary_window ?? rateLimit.secondary);
  const creditsRemaining = extractNumberLike(credits?.balance);

  if (!planText && !primary && !secondary && creditsRemaining === null) {
    return null;
  }

  return {
    source: 'codex-oauth',
    planText,
    primary,
    secondary,
    creditsRemaining
  };
}

function formatCodexQuotaText(snapshot: CodexQuotaSnapshot): string | null {
  return formatRichStateText(richStateFromCodexSnapshot(snapshot));
}

function createHttpStatusError(status: number, url: string): Error & { status?: number } {
  const error = new Error(`HTTP ${status} from ${url}`) as Error & { status?: number };
  error.status = status;
  return error;
}

async function fetchCodexJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });

    if (!response.ok) {
      throw createHttpStatusError(response.status, url);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function readCodexOAuthCredentials(): CodexOAuthCredentials | null {
  if (!fs.existsSync(CODEX_AUTH_FILE)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf8')) as Record<string, unknown>;
    const tokens = asRecord(parsed.tokens) || parsed;
    const accessToken = extractString(tokens.access_token ?? tokens.accessToken);
    const refreshToken = extractString(tokens.refresh_token ?? tokens.refreshToken);
    const accountId = extractString(
      tokens.account_id
        ?? tokens.accountId
        ?? parsed.account_id
        ?? parsed.accountId
    );

    if (!accessToken && !refreshToken) {
      return null;
    }

    return {
      accessToken,
      refreshToken,
      accountId
    };
  } catch (error) {
    logError('Failed to read Codex auth file', error);
    return null;
  }
}

async function refreshCodexAccessToken(refreshToken: string): Promise<string | null> {
  if (!CODEX_OAUTH_CLIENT_ID) {
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
    scope: 'openid profile email'
  });

  const payload = await fetchCodexJson('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body
  });
  const record = asRecord(payload);

  return extractString(record?.access_token ?? record?.accessToken);
}

async function fetchCodexOAuthUsage(accessToken: string, accountId: string | null): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': APP_ID
  };

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  return fetchCodexJson(codexUsageUrl('/wham/usage'), {
    method: 'GET',
    headers
  });
}

async function fetchCodexOAuthQuota(): Promise<CodexQuotaSnapshot | null> {
  const credentials = readCodexOAuthCredentials();
  if (!credentials) {
    return null;
  }

  let accessToken = credentials.accessToken;
  if (!accessToken && credentials.refreshToken) {
    accessToken = await refreshCodexAccessToken(credentials.refreshToken);
  }

  if (!accessToken) {
    return null;
  }

  try {
    return codexQuotaFromUsageResponse(await fetchCodexOAuthUsage(accessToken, credentials.accountId));
  } catch (error) {
    if ((error as { status?: number }).status !== 401 || !credentials.refreshToken) {
      throw error;
    }

    const refreshedToken = await refreshCodexAccessToken(credentials.refreshToken);
    if (!refreshedToken) {
      throw error;
    }

    return codexQuotaFromUsageResponse(await fetchCodexOAuthUsage(refreshedToken, credentials.accountId));
  }
}

async function fetchCodexRpcQuota(): Promise<CodexQuotaSnapshot | null> {
  const child = spawn(CODEX_BIN, ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map<number, PendingJsonRpcRequest>();
  let nextId = 1;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let closed = false;

  function rejectAll(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }

    pending.clear();
  }

  function sendPayload(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function sendServerError(id: number, message: string): void {
    sendPayload({
      id,
      error: {
        code: -32000,
        message
      }
    });
  }

  async function handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (method !== 'account/chatgptAuthTokens/refresh') {
      sendServerError(id, `Unsupported server request: ${method}`);
      return;
    }

    const credentials = readCodexOAuthCredentials();
    const requestParams = asRecord(params);
    const accountId = credentials?.accountId
      || extractString(requestParams?.previousAccountId)
      || null;

    if (!credentials || !credentials.refreshToken || !accountId) {
      sendServerError(id, 'Codex auth refresh credentials are unavailable');
      return;
    }

    const accessToken = await refreshCodexAccessToken(credentials.refreshToken);
    if (!accessToken) {
      sendServerError(id, 'Codex auth refresh returned no access token');
      return;
    }

    sendPayload({
      id,
      result: {
        accessToken,
        chatgptAccountId: accountId,
        chatgptPlanType: null
      }
    });
  }

  function request(method: string, params: Record<string, unknown> = {}, timeoutMs = Math.min(USAGE_TIMEOUT_MS, 8_000)): Promise<Record<string, unknown>> {
    if (closed) {
      return Promise.reject(new Error('Codex RPC process is closed'));
    }

    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex RPC timed out on ${method}`));
      }, timeoutMs);

      pending.set(id, {
        method,
        timeout,
        resolve,
        reject
      });

      try {
        sendPayload({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function handleMessage(message: Record<string, unknown>): void {
    const id = extractNumberLike(message.id);
    if (id === null) {
      return;
    }

    const method = extractString(message.method);
    if (method && message.result === undefined && message.error === undefined) {
      void handleServerRequest(id, method, message.params).catch((error) => {
        try {
          sendServerError(id, error instanceof Error ? error.message : String(error));
        } catch (_) {
          // The child may have already exited.
        }
      });
      return;
    }

    const pendingRequest = pending.get(id);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    pending.delete(id);

    const error = asRecord(message.error);
    if (error) {
      pendingRequest.reject(new Error(extractString(error.message) || `${pendingRequest.method} failed`));
      return;
    }

    pendingRequest.resolve(message);
  }

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line);
        if (message && typeof message === 'object') {
          handleMessage(message as Record<string, unknown>);
        }
      } catch (_) {
        // app-server stdout is expected to be JSON only; ignore stray lines defensively.
      }
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuffer = `${stderrBuffer}${chunk.toString('utf8')}`.slice(-2_000);
  });

  child.on('error', (error: Error) => {
    closed = true;
    rejectAll(error);
  });

  child.on('close', () => {
    closed = true;
    if (pending.size) {
      const detail = stderrBuffer.trim();
      rejectAll(new Error(detail ? `Codex RPC closed: ${detail}` : 'Codex RPC closed'));
    }
  });

  try {
    await request('initialize', {
      clientInfo: {
        name: APP_ID,
        version: VERSION
      }
    });
    sendPayload({ method: 'initialized', params: {} });

    const response = await request('account/rateLimits/read');
    return codexQuotaFromRpcResult(response.result);
  } finally {
    try {
      child.stdin.end();
    } catch (_) {
      // The process may have already closed stdin.
    }

    if (!closed) {
      child.kill('SIGTERM');
    }
  }
}

export async function getNativeCodexQuotaText(
  tool?: ActiveTool,
  quotaSource: CodexQuotaSource = CODEX_QUOTA_SOURCE
): Promise<string | null> {
  if (quotaSource === 'off' || (tool && !isCodexTool(tool))) {
    return null;
  }

  const sources: Array<Exclude<CodexQuotaSource, 'off' | 'auto'>> = quotaSource === 'auto'
    ? ['oauth', 'rpc']
    : [quotaSource];

  for (const source of sources) {
    try {
      const snapshot = source === 'rpc'
        ? await fetchCodexRpcQuota()
        : await fetchCodexOAuthQuota();
      const text = snapshot ? formatCodexQuotaText(snapshot) : null;

      if (text) {
        return text;
      }
    } catch (error) {
      logError(`Codex ${source} quota fetch failed`, error);
    }
  }

  return null;
}

async function getNativeCodexRichState(
  tool?: ActiveTool,
  quotaSource: CodexQuotaSource = CODEX_QUOTA_SOURCE
): Promise<RichStateParts | null> {
  if (quotaSource === 'off' || !isCodexTool(tool)) {
    return null;
  }

  const sources: Array<Exclude<CodexQuotaSource, 'off' | 'auto'>> = quotaSource === 'auto'
    ? ['oauth', 'rpc']
    : [quotaSource];

  for (const source of sources) {
    try {
      const snapshot = source === 'rpc'
        ? await fetchCodexRpcQuota()
        : await fetchCodexOAuthQuota();

      if (snapshot) {
        return richStateFromCodexSnapshot(snapshot, tool);
      }
    } catch (error) {
      logError(`Codex ${source} quota fetch failed`, error);
    }
  }

  return null;
}

function parseClaudeCredentialJson(value: string): unknown | null {
  const text = value.trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function readClaudeKeychainCredentials(): Promise<unknown | null> {
  if (
    process.platform !== 'darwin'
    || envValue('DISCORD_CODING_STATUS_CLAUDE_KEYCHAIN', 'on').trim().toLowerCase() === 'off'
  ) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      CLAUDE_KEYCHAIN_SERVICE,
      '-w'
    ], {
      timeout: 2_000,
      maxBuffer: 256 * 1024
    }) as { stdout: string };
    return parseClaudeCredentialJson(stdout);
  } catch (_) {
    return null;
  }
}

async function readClaudeKeychainAccount(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      CLAUDE_KEYCHAIN_SERVICE
    ], {
      timeout: 2_000,
      maxBuffer: 64 * 1024
    }) as { stdout: string };
    const match = stdout.match(/"acct"<blob>="([^"]+)"/);
    return match?.[1] || null;
  } catch (_) {
    return null;
  }
}

async function writeClaudeKeychainCredentials(value: unknown): Promise<void> {
  if (
    process.platform !== 'darwin'
    || envValue('DISCORD_CODING_STATUS_CLAUDE_KEYCHAIN', 'on').trim().toLowerCase() === 'off'
  ) {
    throw new Error('Claude Code Keychain credentials are available only on macOS.');
  }

  const account = await readClaudeKeychainAccount() || os.userInfo().username;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('security', [
      'add-generic-password',
      '-U',
      '-a',
      account,
      '-s',
      CLAUDE_KEYCHAIN_SERVICE,
      '-w'
    ], {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out while updating Claude Code Keychain credentials.'));
    }, 2_000);

    child.once('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error('Failed to update Claude Code Keychain credentials.'));
      }
    });
    child.stdin.end(`${JSON.stringify(value)}\n`);
  });
}

async function readClaudeFileCredentials(): Promise<unknown | null> {
  if (!fs.existsSync(CLAUDE_CREDENTIALS_FILE)) {
    return null;
  }

  try {
    return parseClaudeCredentialJson(fs.readFileSync(CLAUDE_CREDENTIALS_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function writeClaudeFileCredentials(value: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(CLAUDE_CREDENTIALS_FILE), { recursive: true });
  const tempFile = `${CLAUDE_CREDENTIALS_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, CLAUDE_CREDENTIALS_FILE);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {
      // The successful rename already removed the temporary pathname.
    }
  }
}

const claudeCredentialStore = createClaudeCredentialStore({
  keychain: {
    read: readClaudeKeychainCredentials,
    write: writeClaudeKeychainCredentials,
    async compareAndSwap(expectedGeneration, update) {
      const current = await readClaudeKeychainCredentials();
      if (claudeCredentialGeneration(current) !== expectedGeneration) {
        return false;
      }
      const latest = await readClaudeKeychainCredentials();
      if (claudeCredentialGeneration(latest) !== expectedGeneration) {
        return false;
      }
      await writeClaudeKeychainCredentials(update(latest));
      return true;
    }
  },
  file: {
    read: readClaudeFileCredentials,
    write: writeClaudeFileCredentials,
    async compareAndSwap(expectedGeneration, update) {
      const current = await readClaudeFileCredentials();
      if (claudeCredentialGeneration(current) !== expectedGeneration) {
        return false;
      }
      const latest = await readClaudeFileCredentials();
      if (claudeCredentialGeneration(latest) !== expectedGeneration) {
        return false;
      }
      await writeClaudeFileCredentials(update(latest));
      return true;
    }
  }
});
export const claudeQuotaEngine = new ClaudeQuotaEngine({
  credentials: claudeCredentialStore,
  http: createFetchClaudeHttpClient(),
  userAgent: `claude-code/${VERSION} (${APP_ID})`
});
let lastClaudeQuotaDiagnostic: string | null = null;

function recordClaudeQuotaDiagnostic(message: string | null): void {
  if (!message || message === lastClaudeQuotaDiagnostic) {
    return;
  }

  lastClaudeQuotaDiagnostic = message;
  log(`[claude-quota] ${message}`);
}

async function getNativeClaudeQuotaText(tool?: ActiveTool): Promise<string | null> {
  if (tool && toolFamilyForTool(tool) !== 'claude') {
    return null;
  }

  if (tool && tool.claudeQuotaEligible !== true) {
    recordClaudeQuotaDiagnostic('Claude quota is hidden because the active session is not confirmed as subscription OAuth.');
    return null;
  }

  const result = await claudeQuotaEngine.getQuota(claudeQuotaRequestOptions());
  recordClaudeQuotaDiagnostic(result.diagnostic);
  if (result.status === 'unavailable') {
    return null;
  }

  lastClaudeQuotaDiagnostic = null;
  return result.quota.text;
}

let usageRefreshKick: () => void = () => {};

export function resolveOpencodeApiKey(): string | null {
  const direct = (
    process.env.OPENCODE_API_KEY
    || process.env.DISCORD_CODING_STATUS_OPENCODE_API_KEY
    || ''
  ).trim();
  if (direct) {
    return direct;
  }

  const override = (process.env.DISCORD_CODING_STATUS_OPENCODE_AUTH_FILE || '').trim();
  const files = override
    ? [override]
    : [
        path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
        path.join(os.homedir(), '.config', 'opencode', 'auth.json')
      ];

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      const key = findOpencodeApiKeyDeep(parsed);
      if (key) {
        return key;
      }
    } catch (_) {
      // Auth may live in opencode's SQLite store; the env override still works.
    }
  }

  return null;
}

function findOpencodeApiKeyDeep(value: unknown, depth = 0): string | null {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const mentionsOpencode = JSON.stringify(record).toLowerCase().includes('opencode');
  if (mentionsOpencode) {
    const direct = extractSkLikeKey(record);
    if (direct) {
      return direct;
    }
  }

  for (const [name, child] of Object.entries(record)) {
    // Entries keyed by an opencode provider name (e.g. { "opencode-go": { key: "sk-…" } }) do not
    // necessarily mention "opencode" inside their own value, so search their subtree explicitly.
    if (/opencode/i.test(name) && child && typeof child === 'object') {
      const found = findSkLikeKeyDeep(child, depth + 1);
      if (found) {
        return found;
      }
    }

    const found = findOpencodeApiKeyDeep(child, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function extractSkLikeKey(record: Record<string, unknown>): string | null {
  for (const key of ['key', 'apiKey', 'api_key', 'token', 'credentials', 'value']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && /^sk-?[A-Za-z0-9]/.test(candidate.trim())) {
      return candidate.trim();
    }
  }

  return null;
}

function findSkLikeKeyDeep(value: unknown, depth = 0): string | null {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const direct = extractSkLikeKey(value as Record<string, unknown>);
  if (direct) {
    return direct;
  }

  for (const child of Object.values(value)) {
    const found = findSkLikeKeyDeep(child, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function opencodeWindowPercent(window: unknown): number | null {
  const record = asRecord(window);
  if (!record) {
    return null;
  }
  const value = record.used_percent ?? record.usedPercent ?? record.percent ?? record.usage_percent;
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatOpencodeGoUsage(payload: unknown): string | null {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage);
  if (!usage) {
    return null;
  }

  const windows: string[] = [];
  for (const [key, label] of [['rolling', '5h'], ['weekly', 'weekly'], ['monthly', 'month']] as const) {
    const used = opencodeWindowPercent(usage[key]);
    if (used === null) {
      continue;
    }
    const remaining = Math.max(0, Math.min(100, 100 - used));
    windows.push(`${label} ${Math.round(remaining)}%`);
  }

  return windows.length
    ? formatRichStateText({ planText: 'OpenCode Go', limitsText: joinMetricParts(windows) })
    : null;
}

export async function getNativeOpencodeQuotaText(tool?: ActiveTool): Promise<string | null> {
  if (tool && toolFamilyForTool(tool) !== 'opencode') {
    return null;
  }

  const source = (process.env.DISCORD_CODING_STATUS_OPENCODE_QUOTA_SOURCE || 'auto').trim().toLowerCase();
  if (source === 'off') {
    return null;
  }

  const apiKey = resolveOpencodeApiKey();
  if (!apiKey) {
    return null;
  }

  const base = (
    process.env.DISCORD_CODING_STATUS_OPENCODE_API_BASE_URL
    || 'https://opencode.ai/zen/go/v1'
  ).trim().replace(/\/+$/, '');

  try {
    const payload = await fetchCodexJson(`${base}/usage`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    });
    return formatOpencodeGoUsage(payload);
  } catch (error) {
    logError('OpenCode Go quota fetch failed', error);
    return null;
  }
}

const GROK_DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const GROK_BILLING_AUTH_MARKER = 'xai-grok-cli';
const GROK_WEEKLY_PERIOD_TYPE = 'USAGE_PERIOD_TYPE_WEEKLY';
const GROK_DEFAULT_REFRESH_URL = 'https://auth.x.ai/oauth2/token';
const GROK_DEFAULT_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

function grokRefreshUrl(): string {
  return (process.env.DISCORD_CODING_STATUS_GROK_REFRESH_URL || GROK_DEFAULT_REFRESH_URL).trim();
}

function grokBillingUrl(): string {
  return (process.env.DISCORD_CODING_STATUS_GROK_BILLING_URL || GROK_DEFAULT_BILLING_URL).trim();
}

function grokAuthFilePath(): string {
  return (
    process.env.DISCORD_CODING_STATUS_GROK_AUTH_FILE
    || path.join(os.homedir(), '.grok', 'auth.json')
  ).trim() || path.join(os.homedir(), '.grok', 'auth.json');
}

interface GrokAuthEntry {
  key: string;
  refreshToken?: string;
  refresh?: string;
  expiresAt?: string;
  expires?: string;
  oidcClientId?: string;
}

interface GrokAuthState {
  entryKey: string;
  entry: GrokAuthEntry;
}

function readGrokAuth(): GrokAuthState | null {
  const file = grokAuthFilePath();
  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return null;
    }

    for (const [entryKey, value] of Object.entries(record)) {
      const raw = asRecord(value);
      const key = extractString(raw?.key);
      if (!key) {
        continue;
      }

      return {
        entryKey,
        entry: {
          key,
          refreshToken: extractString(raw?.refresh_token ?? raw?.refreshToken) ?? undefined,
          refresh: extractString(raw?.refresh) ?? undefined,
          expiresAt: extractString(raw?.expires_at ?? raw?.expiresAt) ?? undefined,
          expires: extractString(raw?.expires) ?? undefined,
          oidcClientId: extractString(raw?.oidc_client_id ?? raw?.oidcClientId) ?? undefined
        }
      };
    }
  } catch (error) {
    logError('Failed to read Grok auth file', error);
  }

  return null;
}

function grokClientId(entryKey: string, entry: GrokAuthEntry): string {
  if (entry.oidcClientId) {
    return entry.oidcClientId;
  }

  const parts = entryKey.split('::');
  const candidate = parts[parts.length - 1]?.trim();
  if (candidate) {
    return candidate;
  }

  return GROK_DEFAULT_CLIENT_ID;
}

function grokJwtExpiresAtMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as Record<string, unknown>;
    const exp = payload?.exp;
    if (typeof exp === 'number' && Number.isFinite(exp)) {
      return exp * 1000;
    }
  } catch (_) {
    // Not a JWT; treat as having no embedded expiry.
  }

  return null;
}

function grokEntryExpiresAtMs(entry: GrokAuthEntry): number | null {
  const value = entry.expiresAt ?? entry.expires;
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function grokTokenNeedsRefresh(entry: GrokAuthEntry, token: string): boolean {
  const expiresAt = grokEntryExpiresAtMs(entry) ?? grokJwtExpiresAtMs(token);
  return expiresAt !== null && expiresAt - Date.now() <= GROK_REFRESH_BUFFER_MS;
}

interface GrokRotatedCredentials {
  token: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
}

async function refreshGrokAccessToken(
  entryKey: string,
  entry: GrokAuthEntry
): Promise<GrokRotatedCredentials | null> {
  const refreshToken = entry.refreshToken ?? entry.refresh;
  if (!refreshToken) {
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: grokClientId(entryKey, entry),
    refresh_token: refreshToken
  });

  try {
    const payload = await fetchCodexJson(grokRefreshUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    });

    const record = asRecord(payload);
    const token = extractString(record?.access_token ?? record?.accessToken);
    if (!token) {
      return null;
    }

    const expiresIn = extractNumberLike(record?.expires_in ?? record?.expiresIn);
    const expiresAt = expiresIn !== null && expiresIn > 0
      ? Date.now() + expiresIn * 1000
      : grokJwtExpiresAtMs(token) ?? Date.now() + 60 * 60 * 1000;

    return {
      token,
      refreshToken: extractString(record?.refresh_token ?? record?.refreshToken) ?? undefined,
      idToken: extractString(record?.id_token ?? record?.idToken) ?? undefined,
      expiresAt
    };
  } catch (error) {
    logError('Grok token refresh failed', error);
    return null;
  }
}

function persistGrokCredentials(entryKey: string, rotated: GrokRotatedCredentials): void {
  try {
    const file = grokAuthFilePath();
    const existingText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const existing = existingText ? JSON.parse(existingText) as unknown : {};
    const root = asRecord(existing) ?? {};
    const entry = asRecord(root[entryKey]) ?? {};

    entry.key = rotated.token;
    if (rotated.refreshToken) {
      entry.refresh_token = rotated.refreshToken;
    }
    if (rotated.idToken) {
      entry.id_token = rotated.idToken;
    }
    if (rotated.expiresAt !== undefined) {
      entry.expires_at = new Date(rotated.expiresAt).toISOString();
    }

    root[entryKey] = entry;
    const tempFile = `${file}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, file);
  } catch (error) {
    logError('Failed to persist rotated Grok credentials', error);
  }
}

async function fetchGrokBillingJson(accessToken: string): Promise<unknown> {
  return fetchCodexJson(grokBillingUrl(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-XAI-Token-Auth': GROK_BILLING_AUTH_MARKER,
      Accept: 'application/json'
    }
  });
}

export function formatGrokBillingUsage(payload: unknown): string | null {
  const config = asRecord(asRecord(payload)?.config);
  if (!config) {
    return null;
  }

  const period = asRecord(config.currentPeriod);
  const periodType = extractString(period?.type);
  const usedPercent = extractNumberLike(config.creditUsagePercent);
  const onDemandCap = extractNumberLike(asRecord(config.onDemandCap)?.val);
  const onDemandUsed = extractNumberLike(asRecord(config.onDemandUsed)?.val);
  const prepaid = extractNumberLike(asRecord(config.prepaidBalance)?.val);

  const limits: string[] = [];
  if (periodType === GROK_WEEKLY_PERIOD_TYPE) {
    const percent = usedPercent !== null ? usedPercent : 0;
    limits.push(`Weekly ${Math.round(Math.max(0, Math.min(100, percent)))}%`);
  }

  if (onDemandCap !== null && onDemandCap > 0) {
    limits.push(`PAYG ${String(onDemandCap)} cap`);
  } else if (onDemandCap !== null) {
    limits.push('PAYG off');
  }

  if (onDemandUsed !== null && onDemandUsed > 0) {
    limits.push(`on-demand used ${String(onDemandUsed)}`);
  }

  if (prepaid !== null && prepaid > 0) {
    limits.push(`prepaid ${String(prepaid)}`);
  }

  return limits.length
    ? formatRichStateText({ planText: 'Grok', limitsText: joinMetricParts(limits) })
    : null;
}

export async function getNativeGrokQuotaText(tool?: ActiveTool): Promise<string | null> {
  if (tool && toolFamilyForTool(tool) !== 'grok') {
    return null;
  }

  const source = (process.env.DISCORD_CODING_STATUS_GROK_QUOTA_SOURCE || 'auto').trim().toLowerCase();
  if (source === 'off') {
    return null;
  }

  const auth = readGrokAuth();
  if (!auth) {
    return null;
  }

  const withFreshToken = async (): Promise<string | null> => {
    if (grokTokenNeedsRefresh(auth.entry, auth.entry.key)) {
      const rotated = await refreshGrokAccessToken(auth.entryKey, auth.entry);
      if (!rotated) {
        return null;
      }
      persistGrokCredentials(auth.entryKey, rotated);
      auth.entry = { ...auth.entry, key: rotated.token };
    }
    return auth.entry.key;
  };

  try {
    let token = await withFreshToken();
    if (!token) {
      return null;
    }

    let payload: unknown;
    try {
      payload = await fetchGrokBillingJson(token);
    } catch (error) {
      const status = (error as Error & { status?: number })?.status;
      if (status !== 401 && status !== 403) {
        throw error;
      }

      const rotated = await refreshGrokAccessToken(auth.entryKey, auth.entry);
      if (!rotated) {
        throw error;
      }
      persistGrokCredentials(auth.entryKey, rotated);
      token = rotated.token;
      payload = await fetchGrokBillingJson(token);
    }

    return formatGrokBillingUsage(payload);
  } catch (error) {
    logError('Grok quota fetch failed', error);
    return null;
  }
}

export function registerUsageRefreshKick(kick: () => void): void {
  usageRefreshKick = kick;
}

export async function getUsageText(tool?: ActiveTool): Promise<string | null> {
  if (!shouldShowUsage()) {
    return null;
  }

  const cacheKey = toolFamilyForTool(tool) || 'other';
  const isClaude = cacheKey === 'claude';
  if (isClaude && tool?.claudeQuotaEligible !== true) {
    cachedUsageTextByKey.delete(cacheKey);
    if (tool?.sessionId) {
      claudeUsageRevisionBySession.delete(tool.sessionId);
    }
    return null;
  }

  let cachedUsage = cachedUsageTextByKey.get(cacheKey);
  if (isClaude && tool?.sessionId && tool.updatedAt) {
    const previousRevision = claudeUsageRevisionBySession.get(tool.sessionId);
    if (previousRevision !== tool.updatedAt) {
      claudeUsageRevisionBySession.set(tool.sessionId, tool.updatedAt);
      cachedUsageTextByKey.delete(cacheKey);
      cachedUsage = undefined;
    }
  }

  if (!isClaude && USAGE_TEXT) {
    return truncatePresenceText(USAGE_TEXT);
  }

  const now = Date.now();
  if (cachedUsage && now - cachedUsage.fetchedAt < USAGE_REFRESH_INTERVAL_MS) {
    return cachedUsage.text;
  }

  if (!usageRefreshesByKey.has(cacheKey)) {
    const refresh = refreshUsageText(tool, cacheKey)
      .catch((error) => {
        logError(`Usage refresh failed for ${cacheKey}`, error);
        cachedUsageTextByKey.set(cacheKey, {
          text: isClaude ? null : cachedUsage?.text || null,
          fetchedAt: Date.now()
        });
      })
      .finally(() => {
        usageRefreshesByKey.delete(cacheKey);
        usageRefreshKick();
      });
    usageRefreshesByKey.set(cacheKey, refresh);
  }

  return cachedUsage?.text || (isClaude ? null : PLAN_TEXT_OVERRIDE || null);
}

async function refreshUsageText(tool: ActiveTool | undefined, cacheKey: string): Promise<void> {
  const cachedUsage = cachedUsageTextByKey.get(cacheKey);
  let text: string | null = null;

  const toolFamily = toolFamilyForTool(tool);
  if (toolFamily === 'codex') {
    const nativeCodexRichState = await getNativeCodexRichState(tool);
    const nativeCodexQuotaText = nativeCodexRichState ? formatRichStateText(nativeCodexRichState) : null;
    if (nativeCodexQuotaText) {
      text = nativeCodexQuotaText;
    }
  } else if (toolFamily === 'claude') {
    text = await getNativeClaudeQuotaText(tool);
  } else if (toolFamily === 'opencode') {
    text = await getNativeOpencodeQuotaText(tool);
  } else if (toolFamily === 'grok') {
    text = await getNativeGrokQuotaText(tool);
  } else if (toolFamily === 'cursor') {
    text = await getNativeCursorQuotaText(tool);
  }

  if (!text && toolFamily !== 'claude' && PLAN_TEXT_OVERRIDE) {
    text = PLAN_TEXT_OVERRIDE;
  } else if (!text && toolFamily !== 'claude' && USAGE_COMMAND) {
    try {
      const { stdout } = await execAsync(USAGE_COMMAND, {
        timeout: USAGE_TIMEOUT_MS,
        maxBuffer: 16 * 1024
      }) as { stdout: string };

      text = parseRichStateCommandOutput(stdout, tool);
    } catch (error) {
      logError('Usage command failed', error);
      text = cachedUsage?.text || null;
    }
  }

  const nextText = toolFamily === 'claude'
    ? text
    : text || cachedUsage?.text || null;
  cachedUsageTextByKey.set(cacheKey, {
    text: nextText,
    fetchedAt: Date.now()
  });
  debugLog(
    text
      ? `Usage refresh completed for ${cacheKey}: ${text}.`
      : `Usage refresh unavailable for ${cacheKey}; retaining ${nextText || 'no cached value'}.`
  );
}

export interface HarnessQuotaStatus {
  tool: string;
  status: 'active' | 'unavailable';
  text: string;
}

export async function getNativeCursorQuotaText(tool?: ActiveTool): Promise<string | null> {
  const { fetchCursorQuotaText } = await import('./providers/cursor/quota');
  return fetchCursorQuotaText();
}

export async function fetchAllHarnessQuotas(): Promise<HarnessQuotaStatus[]> {
  const [claudeRes, codexRes, grokRes, opencodeRes, cursorRes] = await Promise.allSettled([
    claudeQuotaEngine.getQuota(claudeQuotaRequestOptions()),
    getNativeCodexQuotaText(undefined, 'auto'),
    getNativeGrokQuotaText(undefined),
    getNativeOpencodeQuotaText(undefined),
    getNativeCursorQuotaText(undefined)
  ]);

  const isClaudeOk = claudeRes.status === 'fulfilled' && claudeRes.value.status !== 'unavailable';
  const claudeText = isClaudeOk
    ? (claudeRes.value as { quota: { text: string } }).quota.text
    : 'Not signed in / API Key';

  const isCodexOk = codexRes.status === 'fulfilled' && Boolean(codexRes.value);
  const codexText = isCodexOk ? codexRes.value! : 'Not signed in';

  const isGrokOk = grokRes.status === 'fulfilled' && Boolean(grokRes.value);
  const grokText = isGrokOk ? grokRes.value! : 'Not signed in';

  const isOpencodeOk = opencodeRes.status === 'fulfilled' && Boolean(opencodeRes.value);
  const opencodeText = isOpencodeOk ? opencodeRes.value! : 'Not signed in';

  const isCursorOk = cursorRes.status === 'fulfilled' && Boolean(cursorRes.value);
  const cursorText = isCursorOk ? cursorRes.value! : 'Not signed in';

  return [
    {
      tool: 'Claude Code',
      status: isClaudeOk ? 'active' : 'unavailable',
      text: claudeText
    },
    {
      tool: 'Codex',
      status: isCodexOk ? 'active' : 'unavailable',
      text: codexText
    },
    {
      tool: 'Grok',
      status: isGrokOk ? 'active' : 'unavailable',
      text: grokText
    },
    {
      tool: 'Cursor',
      status: isCursorOk ? 'active' : 'unavailable',
      text: cursorText
    },
    {
      tool: 'OpenCode',
      status: isOpencodeOk ? 'active' : 'unavailable',
      text: opencodeText
    }
  ];
}
