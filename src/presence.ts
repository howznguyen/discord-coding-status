'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import DiscordRPC from 'discord-rpc';
import {
  DISCORD_APPLICATIONS,
  LARGE_IMAGE_KEY,
  SMALL_IMAGE_KEY,
  FALLBACK_CLIENT_ID,
  SHOW_ACTIVITY,
  SHOW_PROJECT,
  SHOW_MODEL,
  SHOW_QUOTA,
  SHOW_CONTEXT,
  SHOW_PACKAGE,
  PROJECT_NAME_OVERRIDE,
  PACKAGE_NAME_OVERRIDE,
  PLAN_TEXT_OVERRIDE,
  CODEX_QUOTA_SOURCE,
  RECONNECT_INTERVAL_MS,
  CONNECT_TIMEOUT_MS,
  execFileSyncString,
  logError
} from './env';
import {
  statusLabel,
  styledStatusLabel,
  emojiForStatus,
  joinPresenceParts,
  sanitizeBranchName,
  truncatePresenceText,
  sanitizeProjectName,
  sanitizePackageName,
  formatContextText,
  titleCase,
  surfaceLabel,
  statePriority,
  sessionDetails
} from './presence-text';
import {
  cleanupStateSessions,
  coerceStateTimestamp,
  log,
  readStateFile
} from './state-store';
import {
  claudeUsageRevisionBySession,
  getUsageText,
  shouldShowUsage,
  toolFamilyForTool
} from './quota';
import {
  findToolProviderByAlias,
  toolProviders
} from './providers/registry';
import { discordApplicationForTool } from './providers/discord';
import { getCwdForProcess } from './adapters/system/processes';
import type { ActiveTool } from './core/tools/types';
import type {
  PackageInfo,
  PresenceMetadata,
  PresencePayload
} from './core/presence/types';
import type { HookSessionState } from './core/hooks/types';
import type { RpcConnectionState } from './adapters/discord/types';

export const rpcConnections = new Map<string, RpcConnectionState>();

let shuttingDown = false;

// cli.ts owns the daemon loop; it registers a kick callback here so an RPC
// connect can trigger a fresh daemon pass without creating a circular import.
let rpcReadyKick: (() => void) | null = null;

export function setRpcReadyKick(kick: () => void): void {
  rpcReadyKick = kick;
}

export function markShuttingDown(): void {
  shuttingDown = true;
}

function shouldShowProject(): boolean {
  return SHOW_PROJECT;
}

function shouldShowPackage(): boolean {
  return SHOW_PACKAGE;
}

export function clientIdForTool(tool: ActiveTool): string | null {
  const application = discordApplicationForTool(tool, toolProviders, DISCORD_APPLICATIONS);
  return application?.clientId || FALLBACK_CLIENT_ID || null;
}

export function createRpcConnectionState(): RpcConnectionState {
  return {
    client: null,
    ready: false,
    reconnectTimer: null,
    connecting: null,
    activeToolKey: null,
    activityStartedAt: null,
    lastSentActivitySignature: null,
    lastCleared: true,
    connectionAttempt: 0
  };
}

export function rpcStateForClientId(clientId: string): RpcConnectionState {
  let state = rpcConnections.get(clientId);
  if (!state) {
    state = createRpcConnectionState();
    rpcConnections.set(clientId, state);
  }

  return state;
}

export function labelForClientId(clientId: string): string {
  return [...DISCORD_APPLICATIONS.values()].find(
    (application) => application.clientId === clientId
  )?.label || clientId;
}

export function cancelReconnect(state: RpcConnectionState): void {
  if (!state.reconnectTimer) {
    return;
  }

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function scheduleReconnect(clientId: string): void {
  const state = rpcStateForClientId(clientId);
  if (shuttingDown || state.reconnectTimer) {
    return;
  }

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectToDiscord(clientId);
  }, RECONNECT_INTERVAL_MS);
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

export async function connectToDiscord(clientId: string): Promise<void> {
  const state = rpcStateForClientId(clientId);

  if (shuttingDown || state.ready) {
    return;
  }

  if (state.connecting) {
    return state.connecting;
  }

  state.connecting = (async () => {
    const attemptId = ++state.connectionAttempt;
    let client: any | null = null;

    try {
      if (state.client) {
        try {
          state.client.destroy();
        } catch (_) {
          // Best effort cleanup before creating a fresh IPC client.
        }
      }

      DiscordRPC.register(clientId);
      client = new DiscordRPC.Client({ transport: 'ipc' });
      state.client = client;

      client.on('ready', () => {
        if (attemptId !== state.connectionAttempt || client !== state.client) {
          return;
        }

        state.ready = true;
        log(`Connected to Discord Desktop RPC for ${labelForClientId(clientId)}.`);
        if (rpcReadyKick) {
          rpcReadyKick();
        }
      });

      client.on('disconnected', () => {
        if (!shuttingDown && attemptId === state.connectionAttempt && client === state.client) {
          state.ready = false;
          state.lastSentActivitySignature = null;
          state.lastCleared = false;
          log(`Discord RPC disconnected for ${labelForClientId(clientId)}. Will retry.`);
          scheduleReconnect(clientId);
        }
      });

      client.on('error', (error: unknown) => {
        if (!shuttingDown && attemptId === state.connectionAttempt && client === state.client) {
          logError(`Discord RPC error for ${labelForClientId(clientId)}`, error);
        }
      });

      log(`Connecting to Discord Desktop RPC for ${labelForClientId(clientId)}...`);
      const loginPromise = client.login({ clientId });
      loginPromise.catch(() => {});
      await Promise.race([
        loginPromise,
        rejectAfter(CONNECT_TIMEOUT_MS, 'Timed out while waiting for Discord RPC.')
      ]);
    } catch (error) {
      if (client && client === state.client) {
        try {
          client.destroy();
        } catch (_) {
          // Best effort cleanup before retrying.
        }

        state.client = null;
      }

      state.ready = false;
      logError(`Could not connect to Discord RPC for ${labelForClientId(clientId)}. Is Discord Desktop running?`, error);
      scheduleReconnect(clientId);
    } finally {
      if (state.connecting) {
        state.connecting = null;
      }
    }
  })();

  return state.connecting;
}

export function toolFromSession(session: HookSessionState): ActiveTool {
  const tool = session.tool.trim().toLowerCase();
  const surface = session.surface.trim().toLowerCase();
  const status = statusLabel(session.status);
  const surfaceText = surfaceLabel(surface);
  const provider = findToolProviderByAlias(tool, surface, toolProviders);

  if (tool === 'claude' || tool === 'claude-code') {
    return {
      key: `state:${session.session_id}`,
      providerId: provider?.id || 'claudeCode',
      family: 'claude',
      details: sessionDetails(session.activity, 'Using Claude Code'),
      state: joinPresenceParts(['Claude Code', surfaceText, status]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      updatedAt: session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null,
      claudeQuotaEligible: session.claude_quota_eligible ?? null
    };
  }

  if (tool === 'codex') {
    return {
      key: `state:${session.session_id}`,
      providerId: provider?.id || (surface === 'app' ? 'codexApp' : 'codexCli'),
      family: 'codex',
      details: sessionDetails(session.activity, 'Using Codex'),
      state: joinPresenceParts(['Codex', surfaceText, status]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null
    };
  }

  if (provider?.presence) {
    return {
      key: `state:${session.session_id}`,
      providerId: provider.id,
      family: provider.family,
      details: sessionDetails(session.activity, provider.presence.details),
      state: joinPresenceParts([
        provider.discord?.label || provider.presence.state,
        surfaceText,
        status
      ]),
      cwd: session.cwd,
      sessionId: session.session_id,
      startedAt: session.started_at || session.updated_at || null,
      status: session.status,
      activity: session.activity || null,
      model: session.model || null,
      effort: session.effort || null,
      contextText: session.context || null,
      projectName: session.project || null,
      packageName: session.package || null
    };
  }

  return {
    key: `state:${session.session_id}`,
    family: 'other',
    details: sessionDetails(session.activity, `Using ${titleCase(tool)}`),
    state: joinPresenceParts([surfaceText, status]),
    cwd: session.cwd,
    sessionId: session.session_id,
    startedAt: session.started_at || session.updated_at || null,
    status: session.status,
    activity: session.activity || null,
    model: session.model || null,
    effort: session.effort || null,
    contextText: session.context || null,
    projectName: session.project || null,
    packageName: session.package || null
  };
}

function familyKeyForTool(tool: ActiveTool): string {
  const family = toolFamilyForTool(tool);
  return family === 'other' ? `other:${tool.key}` : family;
}

function familyKeyForSession(session: HookSessionState): string {
  return familyKeyForTool(toolFromSession(session));
}

function countStateSessionsByFamily(sessions: HookSessionState[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const key = familyKeyForSession(session);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function detectStateTools(): ActiveTool[] {
  const state = cleanupStateSessions(readStateFile(), Date.now());
  const sessions = Object.values(state.sessions);
  const activeClaudeSessionIds = new Set(
    sessions
      .filter((session) => ['claude', 'claude-code'].includes(session.tool.trim().toLowerCase()))
      .map((session) => session.session_id)
  );
  for (const sessionId of claudeUsageRevisionBySession.keys()) {
    if (!activeClaudeSessionIds.has(sessionId)) {
      claudeUsageRevisionBySession.delete(sessionId);
    }
  }

  if (!sessions.length) {
    return [];
  }

  sessions.sort((a, b) => {
    const priorityDelta = statePriority(b.status) - statePriority(a.status);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return b.updated_at - a.updated_at;
  });

  const tools: ActiveTool[] = [];
  const seenFamilies = new Set<string>();
  const sessionCounts = countStateSessionsByFamily(sessions);

  for (const session of sessions) {
    const tool = toolFromSession(session);
    const key = familyKeyForTool(tool);

    if (seenFamilies.has(key)) {
      continue;
    }

    tools.push({ ...tool, sessionCount: sessionCounts.get(key) || null });
    seenFamilies.add(key);
  }

  return tools;
}

export function detectStateTool(): ActiveTool | null {
  return detectStateTools()[0] || null;
}

export function mergeActiveTools(primary: ActiveTool[], fallback: ActiveTool[]): ActiveTool[] {
  const tools: ActiveTool[] = [];
  const seen = new Set<string>();

  for (const tool of [...primary, ...fallback]) {
    const key = familyKeyForTool(tool);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    tools.push(tool);
  }

  return tools;
}

function isLikelyAppInternalPath(directory: string | null | undefined): boolean {
  const normalized = String(directory || '').toLowerCase();

  return (
    !normalized ||
    normalized === '/' ||
    normalized.includes('.app/contents/') ||
    normalized.includes('/applications/codex.app') ||
    normalized.includes('/applications/discord.app')
  );
}

export function readPackageInfo(startDirectory: string | null): PackageInfo | null {
  if (!startDirectory || isLikelyAppInternalPath(startDirectory)) {
    return null;
  }

  let current = startDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = path.join(current, 'package.json');

    if (fs.existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        return {
          root: current,
          name: typeof packageJson.name === 'string' ? packageJson.name : null
        };
      } catch (_) {
        return {
          root: current,
          name: null
        };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

export function getGitBranch(directory: string | null): string | null {
  if (!directory || isLikelyAppInternalPath(directory)) {
    return null;
  }

  try {
    const branch = execFileSyncString('git', ['-C', directory, 'symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    return sanitizeBranchName(branch);
  } catch (_) {
    try {
      const commit = execFileSyncString('git', ['-C', directory, 'rev-parse', '--short', 'HEAD']).trim();
      return commit ? `detached:${commit}` : null;
    } catch (_) {
      return null;
    }
  }
}

export async function getPresenceMetadata(tool: ActiveTool): Promise<PresenceMetadata> {
  const metadata: PresenceMetadata = {
    projectName: null,
    packageName: null,
    branchName: null,
    usageText: null
  };

  if (!shouldShowProject() && !shouldShowPackage() && !shouldShowUsage()) {
    return metadata;
  }

  const cwd = tool.cwd || await getCwdForProcess(tool.processInfo);
  const packageInfo = readPackageInfo(cwd);
  const projectRoot = packageInfo?.root || cwd;

  if (shouldShowProject()) {
    metadata.projectName = sanitizeProjectName(PROJECT_NAME_OVERRIDE)
      || sanitizeProjectName(tool.projectName)
      || sanitizeProjectName(packageInfo && packageInfo.root)
      || sanitizeProjectName(cwd);
  }

  metadata.branchName = getGitBranch(projectRoot);

  if (shouldShowPackage()) {
    metadata.packageName = sanitizePackageName(PACKAGE_NAME_OVERRIDE)
      || sanitizePackageName(tool.packageName)
      || sanitizePackageName(packageInfo && packageInfo.name);
  }

  metadata.usageText = await getUsageText(tool);
  return metadata;
}

export function activityTextForPresence(tool: ActiveTool): string {
  return truncatePresenceText(
    tool.activity
      || styledStatusLabel(tool.status)
      || tool.details
      || tool.state
  );
}

function projectBranchText(metadata: PresenceMetadata): string | null {
  if (metadata.projectName && metadata.branchName) {
    return `${metadata.projectName} @ ${metadata.branchName}`;
  }

  return metadata.projectName;
}

function modelTextForPresence(tool: ActiveTool): string | null {
  const model = String(tool.model || '').replace(/\s+/g, ' ').trim();
  const effort = String(tool.effort || '').replace(/\s+/g, ' ').trim();

  if (!model) {
    return null;
  }

  return truncatePresenceText(effort ? `${model} · ${effort}` : model);
}

function sessionStatusEmoji(tool: ActiveTool): string {
  return emojiForStatus(tool.status) || '';
}

function activityEmojiText(tool: ActiveTool, activityText: string): string {
  const emoji = sessionStatusEmoji(tool);
  return emoji ? `${emoji} ${activityText}`.trim() : activityText;
}

export async function enrichToolForPresence(tool: ActiveTool | null): Promise<ActiveTool | null> {
  if (!tool) {
    return null;
  }

  const metadata = await getPresenceMetadata(tool);
  const activityText = activityTextForPresence(tool);
  const modelText = modelTextForPresence(tool);
  const contextText = formatContextText(tool.contextText);
  const sessionMarker = tool.sessionCount && tool.sessionCount > 1
    ? `👥 ${tool.sessionCount}`
    : null;
  const details = joinPresenceParts([
    sessionMarker,
    SHOW_ACTIVITY ? activityEmojiText(tool, activityText) : null,
    SHOW_PROJECT ? projectBranchText(metadata) : null
  ]);
  const quotaFallback = toolFamilyForTool(tool) === 'codex'
    ? PLAN_TEXT_OVERRIDE || (CODEX_QUOTA_SOURCE === 'off' ? 'Codex quota disabled' : 'Codex quota unavailable')
    : null;
  const state = joinPresenceParts([
    SHOW_MODEL ? modelText : null,
    SHOW_QUOTA ? metadata.usageText || quotaFallback : null,
    SHOW_CONTEXT ? contextText : null,
    SHOW_PACKAGE && metadata.packageName ? `pkg ${metadata.packageName}` : null
  ]);

  return {
    ...tool,
    details,
    state
  };
}

export async function enrichToolsForPresence(tools: ActiveTool[]): Promise<ActiveTool[]> {
  const enriched = await Promise.all(tools.map((tool) => enrichToolForPresence(tool)));
  return enriched.filter((tool): tool is ActiveTool => Boolean(tool));
}

export function buildPresence(tool: ActiveTool, activityStartedAt: Date | null): PresencePayload {
  const presence: PresencePayload = {
    startTimestamp: activityStartedAt || new Date(),
    instance: false
  };
  const largeImageKey = largeImageKeyForTool(tool);

  if (tool.details) {
    presence.details = tool.details;
  }

  if (tool.state) {
    presence.state = tool.state;
  }

  if (largeImageKey) {
    presence.largeImageKey = largeImageKey;
  }

  if (SMALL_IMAGE_KEY) {
    presence.smallImageKey = SMALL_IMAGE_KEY;
  }

  return presence;
}

function largeImageKeyForTool(tool: ActiveTool): string | null {
  const application = discordApplicationForTool(tool, toolProviders, DISCORD_APPLICATIONS);
  return application?.imageKey || LARGE_IMAGE_KEY || null;
}

function activityStartDate(tool: ActiveTool): Date {
  const startedAt = coerceStateTimestamp(tool.startedAt);
  if (!startedAt) {
    return new Date();
  }

  const date = new Date(startedAt);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function getActivitySignature(tool: ActiveTool, activityStartedAt: Date | null): string {
  return [
    clientIdForTool(tool),
    tool.key,
    tool.details,
    tool.state,
    activityStartedAt,
    largeImageKeyForTool(tool),
    SMALL_IMAGE_KEY
  ].join('|');
}

export async function clearConnectionActivity(clientId: string, state: RpcConnectionState): Promise<void> {
  state.activeToolKey = null;
  state.activityStartedAt = null;
  state.lastSentActivitySignature = null;
  cancelReconnect(state);

  if (!state.ready || !state.client) {
    state.lastCleared = true;
    return;
  }

  if (!state.lastCleared) {
    await state.client.clearActivity();
    state.lastCleared = true;
    log(`Cleared Discord activity for ${labelForClientId(clientId)}.`);
  }
}

async function updateActivityForClient(clientId: string, tool: ActiveTool): Promise<void> {
  const state = rpcStateForClientId(clientId);

  if (state.activeToolKey !== tool.key) {
    state.activeToolKey = tool.key;
    state.activityStartedAt = activityStartDate(tool);
    state.lastSentActivitySignature = null;
    state.lastCleared = false;
    log(`Detected ${tool.state} for ${labelForClientId(clientId)}.`);
  } else if (!state.activityStartedAt) {
    state.activityStartedAt = activityStartDate(tool);
    state.lastSentActivitySignature = null;
  }

  if (!state.ready || !state.client) {
    await connectToDiscord(clientId);
  }

  if (!state.ready || !state.client) {
    return;
  }

  const signature = getActivitySignature(tool, state.activityStartedAt);
  if (signature === state.lastSentActivitySignature) {
    return;
  }

  await state.client.setActivity(buildPresence(tool, state.activityStartedAt));
  state.lastSentActivitySignature = signature;
  state.lastCleared = false;
  log(`Updated ${labelForClientId(clientId)} activity: ${tool.details} / ${tool.state}.`);
}

export async function updateActivities(tools: ActiveTool[]): Promise<void> {
  const activeByClientId = new Map<string, ActiveTool>();

  for (const tool of tools) {
    const clientId = clientIdForTool(tool);
    if (!clientId || activeByClientId.has(clientId)) {
      continue;
    }

    activeByClientId.set(clientId, tool);
  }

  for (const [clientId, state] of rpcConnections) {
    if (!activeByClientId.has(clientId)) {
      await clearConnectionActivity(clientId, state);
    }
  }

  for (const [clientId, tool] of activeByClientId) {
    await updateActivityForClient(clientId, tool);
  }
}

export async function updateActivity(tool: ActiveTool | null): Promise<void> {
  await updateActivities(tool ? [tool] : []);
}
