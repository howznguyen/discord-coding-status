import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ACTIVITY_STYLE,
  APP_ID,
  CLAUDE_SETTINGS_FILE,
  DEBUG_ENABLED,
  STATE_FILE,
  STATE_LOCK_TIMEOUT_MS,
  STATE_MAX_AGE_MS,
  asRecord,
  dim,
  execFileSyncString,
  extractString,
  logError
} from './env';
import {
  isTerminalStatus,
  normalizeStatus,
  pickTimedMessage
} from './presence-text';
import {
  extractClaudeModelFromHookInput,
  extractClaudeSessionId,
  readClaudeModelFromTranscript
} from './claude-hooks';
import {
  evaluateClaudeQuotaEligibility,
  type ClaudeQuotaRequestOptions
} from './claude-quota';
import { getArgString } from './commands/args';
import { resolveHomePath } from './commands/config/settings';
import type { ActivityStyle } from './commands/config/types';
import type { HookSessionState, HookStateFile } from './core/hooks/types';

export function log(message: string): void {
  console.log(`${dim(`[${APP_ID}]`)} ${dim(new Date().toISOString())} ${message}`);
}

export function debugLog(message: string): void {
  if (DEBUG_ENABLED) {
    log(`[debug] ${message}`);
  }
}

export function readStateFile(): HookStateFile {
  if (!fs.existsSync(STATE_FILE)) {
    return { version: 1, sessions: {} };
  }

  try {
    const content = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (!content) {
      return { version: 1, sessions: {} };
    }

    const parsed = JSON.parse(content) as Partial<HookStateFile>;
    if (!parsed || typeof parsed !== 'object' || !parsed.sessions || typeof parsed.sessions !== 'object') {
      return { version: 1, sessions: {} };
    }

    return {
      version: 1,
      sessions: parsed.sessions as Record<string, HookSessionState>
    };
  } catch (error) {
    logError('Failed to read state file', error);
    return { version: 1, sessions: {} };
  }
}

export function writeStateFile(state: HookStateFile): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const tmpPath = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmpPath, STATE_FILE);
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withStateLock<T>(operation: () => T): T {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const lockPath = `${STATE_FILE}.lock`;
  const startedAt = Date.now();
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n`);
    } catch (error) {
      if (Date.now() - startedAt > STATE_LOCK_TIMEOUT_MS) {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > STATE_LOCK_TIMEOUT_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (_) {
          continue;
        }

        throw error;
      }

      sleepSync(25);
    }
  }

  try {
    return operation();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }

    try {
      fs.unlinkSync(lockPath);
    } catch (_) {
      // Another process may have cleaned a stale lock.
    }
  }
}

export function cleanupStateSessions(state: HookStateFile, now = Date.now()): HookStateFile {
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([, session]) => {
      if (!session || typeof session !== 'object') {
        return false;
      }

      if (isTerminalStatus(session.status)) {
        return false;
      }

      if (!session.updated_at || now - session.updated_at > STATE_MAX_AGE_MS) {
        return false;
      }

      return true;
    })
  );

  return { version: 1, sessions };
}

export function readOptionalStdin(): string {
  try {
    if (!process.stdin.isTTY) {
      return fs.readFileSync(0, 'utf8');
    }
  } catch (_) {
    // No readable stdin for manual invocations.
  }

  return '';
}

export function readHookInput(): Record<string, unknown> {
  const stdin = readOptionalStdin().trim();
  if (!stdin) {
    return {};
  }

  try {
    const parsed = JSON.parse(stdin);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch (_) {
    return {};
  }
}

export function findStringDeep(value: unknown, keys: string[], depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 4) {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === 'string' && found.trim()) {
      return found.trim();
    }
  }

  for (const nested of Object.values(record)) {
    const found = findStringDeep(nested, keys, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

export function readCodexTurnMetadata(transcriptPath: string | null): { model: string | null; effort: string | null } {
  const unavailable = { model: null, effort: null };
  if (!transcriptPath) {
    return unavailable;
  }

  let fd: number | null = null;

  try {
    const resolvedPath = path.resolve(resolveHomePath(transcriptPath));
    const stat = fs.statSync(resolvedPath);
    const maxBytes = 2 * 1024 * 1024;
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(resolvedPath, 'r');
    fs.readSync(fd, buffer, 0, length, start);

    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }

    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }

      try {
        const record = asRecord(JSON.parse(line));
        if (!record || record.type !== 'turn_context') {
          continue;
        }

        const payload = asRecord(record.payload);
        if (!payload) {
          continue;
        }

        return {
          model: extractString(payload.model),
          effort: extractString(
            payload.effort
              ?? payload.reasoning_effort
              ?? payload.reasoningEffort
              ?? payload.model_reasoning_effort
              ?? payload.modelReasoningEffort
          )
        };
      } catch (_) {
        // Ignore incomplete or non-JSON transcript lines while scanning backwards.
      }
    }
  } catch (error) {
    debugLog(`Codex transcript metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // Best effort cleanup for a local transcript read.
      }
    }
  }

  return unavailable;
}

export function safeCommandSummary(command: string | null): string | null {
  if (!command) {
    return null;
  }

  const tokens = command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  if (!tokens.length) {
    return null;
  }

  const executable = path.basename(tokens[0]);
  if (!/^[\w.+-]+$/.test(executable)) {
    return null;
  }

  const safeArgs = tokens
    .slice(1, 3)
    .filter((token) => /^[\w:@+-]+$/.test(token) && !/[=]/.test(token));

  return [executable, ...safeArgs].join(' ');
}

export function pickHookActivity(key: string, messages: string[]): string {
  return pickTimedMessage(`hook:${key}`, messages);
}

export function conventionalCodexHookActivity(
  event: string,
  toolName: string | null,
  command: string | null,
  style: Exclude<ActivityStyle, 'fun'>
): string | null {
  const normalized = event.trim().toLowerCase();

  if (style === 'minimal') {
    if (normalized === 'permissionrequest' || normalized === 'permission_request') {
      return 'Waiting';
    }
    if (normalized === 'stop') {
      return 'Idle';
    }
    if (normalized === 'sessionstart' || normalized === 'session_start') {
      return 'Starting';
    }
    return 'Working';
  }

  if (normalized === 'permissionrequest' || normalized === 'permission_request') {
    return style === 'technical' ? 'Permission requested' : 'Waiting for approval';
  }

  if (normalized === 'stop') {
    return style === 'technical' ? 'Codex idle' : 'Waiting for input';
  }

  if (normalized === 'pretooluse' || normalized === 'pre_tool_use') {
    if (style === 'technical') {
      return command ? `Running ${command}` : (toolName ? `Running ${toolName}` : 'Tool running');
    }
    return toolName ? `Using ${toolName}` : 'Running a command';
  }

  if (normalized === 'posttooluse' || normalized === 'post_tool_use') {
    if (style === 'technical') {
      return toolName ? `Finished ${toolName}` : 'Tool finished';
    }
    return 'Command completed';
  }

  if (normalized === 'userpromptsubmit' || normalized === 'user_prompt_submit') {
    return style === 'technical' ? 'Prompt submitted' : 'Processing prompt';
  }

  if (normalized === 'sessionstart' || normalized === 'session_start') {
    return style === 'technical' ? 'Session started' : 'Starting Codex session';
  }

  return null;
}

export function activityFromCodexHook(event: string, input: Record<string, unknown>): string | null {
  const normalized = event.trim().toLowerCase();
  const toolName = findStringDeep(input, ['tool_name', 'toolName', 'tool']);
  const command = safeCommandSummary(findStringDeep(input, ['command', 'cmd']));

  if (ACTIVITY_STYLE !== 'fun') {
    return conventionalCodexHookActivity(event, toolName, command, ACTIVITY_STYLE);
  }

  if (normalized === 'permissionrequest' || normalized === 'permission_request') {
    return pickHookActivity('permission', [
      'Waiting for the sacred yes',
      'Permission checkpoint in progress',
      'Holding the risky command politely',
      'Approval pending, hands visible',
      'Standing outside sudo with respect'
    ]);
  }

  if (normalized === 'stop') {
    return pickHookActivity('stop', [
      'Waiting for the next plot twist',
      'Your move, captain',
      'Standing by with a clean diff',
      'Prompt ball is on your side',
      'Ready when the keyboard is'
    ]);
  }

  if (normalized === 'pretooluse' || normalized === 'pre_tool_use') {
    if (command) {
      return pickHookActivity(`pre-command:${command}`, [
        `Running ${command}`,
        `Letting ${command} cook`,
        `Giving ${command} the keyboard`,
        `Convincing ${command} to behave`,
        `Escorting ${command} through reality`
      ]);
    }

    return toolName
      ? pickHookActivity(`pre-tool:${toolName}`, [
        `Running ${toolName}`,
        `Letting ${toolName} earn its keep`,
        `Putting ${toolName} to work`,
        `Asking ${toolName} politely`,
        `Sending ${toolName} into the codebase`
      ])
      : pickHookActivity('pre-tool', [
        'Running a tool',
        'Doing tool-shaped work',
        'Consulting the toolbox',
        'Making the machine useful',
        'Executing the next tiny plan'
      ]);
  }

  if (normalized === 'posttooluse' || normalized === 'post_tool_use') {
    return toolName
      ? pickHookActivity(`post-tool:${toolName}`, [
        `Finished ${toolName}`,
        `${toolName} returned receipts`,
        `${toolName} survived the assignment`,
        `${toolName} handed back the clipboard`,
        `${toolName} did the thing`
      ])
      : pickHookActivity('post-tool', [
        'Finished tool work',
        'Tool returned receipts',
        'One tiny plan completed',
        'The tool did the thing',
        'Back from the tool trip'
      ]);
  }

  if (normalized === 'userpromptsubmit' || normalized === 'user_prompt_submit') {
    return pickHookActivity('prompt', [
      'Processing a fresh prompt',
      'Reading the new plot twist',
      'Turning words into work',
      'Parsing ambition',
      'Loading context with intent'
    ]);
  }

  if (normalized === 'sessionstart' || normalized === 'session_start') {
    return pickHookActivity('session-start', [
      'Codex session started',
      'Opening a clean context window',
      'New session, fresh confidence',
      'Booting the coding cockpit',
      'Starting the next diff arc'
    ]);
  }

  return null;
}

export function findCodexAncestorPid(startPid = process.ppid): number {
  let currentPid = startPid;

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const output = execFileSyncString('ps', ['-p', String(currentPid), '-o', 'ppid=,comm=,args=']);
      const line = output.trim();
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return currentPid;
      }

      const parentPid = Number(match[1]);
      const commandText = match[2].toLowerCase();

      if (/(^|[\s/])codex($|[\s/.-])/.test(commandText) || commandText.includes('/codex.app/')) {
        return currentPid;
      }

      if (!parentPid || parentPid === currentPid) {
        return currentPid;
      }

      currentPid = parentPid;
    } catch (_) {
      return currentPid;
    }
  }

  return currentPid;
}

export function isGrokProcessAncestry(startPid = process.ppid): boolean {
  if (
    Boolean(
      process.env.GROK_EVENT ||
      process.env.GROK_SESSION_ID ||
      process.env.GROK_MESSAGE ||
      process.env.GROK_DIR ||
      process.env.GROK_BIN
    )
  ) {
    return true;
  }

  let currentPid = startPid;

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const output = execFileSyncString('ps', ['-p', String(currentPid), '-o', 'ppid=,comm=,args=']);
      const line = output.trim();
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return false;
      }

      const parentPid = Number(match[1]);
      const commandText = match[2].toLowerCase();

      if (/(?:^|[\s/])grok(?:[/.][^\s]*)?(?:\s|$)/.test(commandText)) {
        return true;
      }

      if (!parentPid || parentPid === currentPid) {
        return false;
      }

      currentPid = parentPid;
    } catch (_) {
      return false;
    }
  }

  return false;
}

export function buildSessionId(state: Pick<HookSessionState, 'tool' | 'surface' | 'cwd'>): string {
  return `${state.tool}:${state.surface}:${state.cwd}`;
}

export function coerceStateTimestamp(value: unknown, fallback?: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const now = Date.now();
    return value <= now + 60_000 ? Math.round(value) : fallback;
  }

  return fallback;
}

export function coerceHookSessionState(value: unknown): HookSessionState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const input = value as Partial<HookSessionState>;
  const tool = String(input.tool || '').trim().toLowerCase();
  const surface = String(input.surface || 'cli').trim().toLowerCase();
  const status = normalizeStatus(input.status);
  const cwd = path.resolve(String(input.cwd || process.cwd()));
  const session_id = String(input.session_id || buildSessionId({ tool, surface, cwd })).trim();
  const now = Date.now();
  const updated_at = coerceStateTimestamp(input.updated_at, now) || now;
  const started_at = coerceStateTimestamp(input.started_at);

  if (!tool || !surface || !session_id) {
    return null;
  }

  return {
    tool,
    surface,
    status,
    session_id,
    cwd,
    updated_at,
    started_at,
    project: typeof input.project === 'string' ? input.project : undefined,
    package: typeof input.package === 'string' ? input.package : undefined,
    title: typeof input.title === 'string' ? input.title : undefined,
    activity: typeof input.activity === 'string' ? input.activity : undefined,
    model: typeof input.model === 'string' ? input.model : undefined,
    effort: typeof input.effort === 'string' ? input.effort : undefined,
    context: typeof input.context === 'string' ? input.context : undefined,
    claude_quota_eligible: typeof input.claude_quota_eligible === 'boolean'
      ? input.claude_quota_eligible
      : undefined
  };
}

export function sessionFromArgs(args: Record<string, string | boolean>): HookSessionState | null {
  const json = getArgString(args, 'json');
  if (json) {
    try {
      return coerceHookSessionState(JSON.parse(json));
    } catch (error) {
      logError('Invalid hook JSON', error);
      return null;
    }
  }

  return coerceHookSessionState({
    tool: getArgString(args, 'tool'),
    surface: getArgString(args, 'surface') || 'cli',
    status: getArgString(args, 'status') || 'active',
    session_id: getArgString(args, 'session-id') || getArgString(args, 'session_id') || undefined,
    cwd: getArgString(args, 'cwd') || process.cwd(),
    project: getArgString(args, 'project') || undefined,
    package: getArgString(args, 'package') || undefined,
    title: getArgString(args, 'title') || undefined,
    activity: getArgString(args, 'activity') || undefined,
    model: getArgString(args, 'model') || undefined,
    effort: getArgString(args, 'effort')
      || getArgString(args, 'reasoning-effort')
      || getArgString(args, 'model-reasoning-effort')
      || undefined,
    context: getArgString(args, 'context') || undefined
  });
}

export function codexHookSessionFromArgs(args: Record<string, string | boolean>): HookSessionState {
  const input = readHookInput();
  const transcriptPath = findStringDeep(input, ['transcript_path', 'transcriptPath']);
  const turnMetadata = readCodexTurnMetadata(transcriptPath);
  const event = getArgString(args, 'event') || findStringDeep(input, ['event', 'hook_event', 'hookEvent']) || 'unknown';
  const status = getArgString(args, 'status') || statusFromCodexHookEvent(event);
  const cwd = path.resolve(
    getArgString(args, 'cwd')
      || findStringDeep(input, ['cwd', 'current_working_directory', 'working_directory', 'workspace'])
      || process.cwd()
  );
  const sessionId = getArgString(args, 'session-id')
    || getArgString(args, 'session_id')
    || findStringDeep(input, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId'])
    || `codex:cli:${cwd}:${findCodexAncestorPid()}`;

  return {
    tool: 'codex',
    surface: getArgString(args, 'surface') || 'cli',
    status,
    session_id: sessionId,
    cwd,
    updated_at: Date.now(),
    project: getArgString(args, 'project') || undefined,
    package: getArgString(args, 'package') || undefined,
    title: getArgString(args, 'title') || undefined,
    activity: getArgString(args, 'activity') || activityFromCodexHook(event, input) || undefined,
    model: getArgString(args, 'model')
      || findStringDeep(input, ['model', 'modelName', 'model_name'])
      || turnMetadata.model
      || undefined,
    effort: getArgString(args, 'effort')
      || getArgString(args, 'reasoning-effort')
      || findStringDeep(input, ['effort', 'reasoning_effort', 'reasoningEffort', 'model_reasoning_effort', 'modelReasoningEffort'])
      || turnMetadata.effort
      || undefined,
    context: getArgString(args, 'context') || findStringDeep(input, ['context', 'context_used', 'contextUsed']) || undefined
  };
}

export function statusFromClaudeHookEvent(event: string): string {
  const normalized = event.trim().toLowerCase().replace(/_/g, '');

  if (normalized === 'sessionend') {
    return 'stopped';
  }

  if (normalized === 'notification') {
    return 'waiting_input';
  }

  return statusFromCodexHookEvent(event);
}

export function activityFromClaudeHook(event: string, input: Record<string, unknown>): string | null {
  const activity = activityFromCodexHook(event, input);
  return activity ? activity.replace(/Codex/g, 'Claude Code') : null;
}

export function claudeHookSessionFromArgs(args: Record<string, string | boolean>): HookSessionState {
  const input = readHookInput();
  const transcriptPath = findStringDeep(input, ['transcript_path', 'transcriptPath']);
  const event = getArgString(args, 'event')
    || findStringDeep(input, ['hook_event_name', 'hook_event', 'hookEvent', 'event'])
    || 'unknown';
  const cwd = path.resolve(
    getArgString(args, 'cwd')
      || findStringDeep(input, ['cwd', 'current_working_directory', 'working_directory', 'workspace'])
      || process.cwd()
  );
  const sessionId = getArgString(args, 'session-id')
    || getArgString(args, 'session_id')
    || extractClaudeSessionId(input)
    || findStringDeep(input, ['conversation_id', 'conversationId', 'thread_id', 'threadId'])
    || `claude:cli:${cwd}:${process.ppid}`;
  const model = getArgString(args, 'model')
    || extractClaudeModelFromHookInput(input)
    || readClaudeModelFromTranscript(transcriptPath)
    || undefined;
  const quotaRequestOptions = claudeQuotaRequestOptions();
  const eligibility = evaluateClaudeQuotaEligibility(
    quotaRequestOptions.environment || process.env,
    quotaRequestOptions.mode
  );

  return {
    tool: 'claude',
    surface: getArgString(args, 'surface') || 'cli',
    status: getArgString(args, 'status') || statusFromClaudeHookEvent(event),
    session_id: sessionId,
    cwd,
    updated_at: Date.now(),
    project: getArgString(args, 'project') || undefined,
    package: getArgString(args, 'package') || undefined,
    title: getArgString(args, 'title') || undefined,
    activity: getArgString(args, 'activity') || activityFromClaudeHook(event, input) || undefined,
    model,
    context: getArgString(args, 'context') || undefined,
    claude_quota_eligible: eligibility.eligible
  };
}

export function statusFromCodexHookEvent(event: string): string {
  const normalized = event.trim().toLowerCase();

  if (normalized === 'permissionrequest' || normalized === 'permission_request') {
    return 'waiting_approval';
  }

  if (normalized === 'stop') {
    return 'waiting_input';
  }

  if (normalized === 'sessionstart' || normalized === 'session_start') {
    return 'running';
  }

  if (
    normalized === 'userpromptsubmit' ||
    normalized === 'user_prompt_submit' ||
    normalized === 'pretooluse' ||
    normalized === 'pre_tool_use' ||
    normalized === 'posttooluse' ||
    normalized === 'post_tool_use'
  ) {
    return 'running';
  }

  return 'active';
}

export function isSameLogicalSession(left: HookSessionState, right: HookSessionState): boolean {
  return (
    left.tool === right.tool &&
    left.surface === right.surface &&
    path.resolve(left.cwd) === path.resolve(right.cwd)
  );
}

export function findReusableSessionId(state: HookStateFile, session: HookSessionState): string | null {
  if (state.sessions[session.session_id]) {
    return session.session_id;
  }

  const matches = Object.entries(state.sessions)
    .filter(([, existing]) => isSameLogicalSession(existing, session));

  return matches.length === 1 ? matches[0][0] : null;
}

export function upsertHookState(session: HookSessionState): void {
  withStateLock(() => {
    const now = Date.now();
    const state = cleanupStateSessions(readStateFile(), now);
    const reusableSessionId = findReusableSessionId(state, session);

    if (isTerminalStatus(session.status)) {
      delete state.sessions[session.session_id];
      if (reusableSessionId) {
        delete state.sessions[reusableSessionId];
      }
    } else {
      const reusableSession = reusableSessionId ? state.sessions[reusableSessionId] : null;
      const startedAt = coerceStateTimestamp(
        session.started_at,
        coerceStateTimestamp(reusableSession?.started_at, coerceStateTimestamp(reusableSession?.updated_at, now))
      ) || now;

      if (reusableSessionId && reusableSessionId !== session.session_id) {
        delete state.sessions[reusableSessionId];
      }

      state.sessions[session.session_id] = {
        ...reusableSession,
        ...session,
        model: session.model || reusableSession?.model,
        effort: session.effort || reusableSession?.effort,
        started_at: startedAt
      };
    }

    writeStateFile(state);
  });
}

export function clearHookState(sessionId?: string): void {
  withStateLock(() => {
    const state = readStateFile();
    if (sessionId) {
      delete state.sessions[sessionId];
    } else {
      state.sessions = {};
    }

    writeStateFile(cleanupStateSessions(state, Date.now()));
  });
}

export function readClaudeSettings(): Record<string, unknown> {
  if (!fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    return {};
  }

  const parsed = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf8')) as unknown;
  return asRecord(parsed) || {};
}

export function claudeQuotaRequestOptions(): ClaudeQuotaRequestOptions {
  try {
    const settings = readClaudeSettings();
    const configuredEnvironment = asRecord(settings.env) || {};
    const environment: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(configuredEnvironment)) {
      if (
        typeof value === 'string'
        && value.trim()
        && !String(environment[key] || '').trim()
      ) {
        environment[key] = value;
      }
    }

    return {
      mode: extractString(settings.apiKeyHelper) ? 'api-key' : 'auto',
      environment
    };
  } catch (_) {
    return {
      mode: 'custom-provider',
      environment: process.env
    };
  }
}
