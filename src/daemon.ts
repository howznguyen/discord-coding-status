'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  detectActiveTools
} from './core/detection/active-tools';
import {
  getProcessList
} from './adapters/system/processes';
import {
  toolProviders
} from './providers/registry';
import {
  APP_TITLE,
  DETAIL_LEVEL,
  DISCORD_APPLICATIONS,
  FALLBACK_CLIENT_ID,
  POLL_INTERVAL_MS,
  PREFER_CODEX_CLI,
  PROCESS_DETECTION_ENABLED,
  STATE_FILE,
  STATE_WATCH_DEBOUNCE_MS,
  danger,
  dim,
  logError
} from './env';
import {
  cancelReconnect,
  detectStateTools,
  enrichToolsForPresence,
  labelForClientId,
  markShuttingDown,
  mergeActiveTools,
  rpcConnections,
  setRpcReadyKick,
  updateActivities
} from './presence';
import {
  registerUsageRefreshKick
} from './quota';
import {
  debugLog,
  log
} from './state-store';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let stateWatcher: import('node:fs').FSWatcher | null = null;
let stateWatchTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

setRpcReadyKick(() => {
  void runLoopOnce();
});

registerUsageRefreshKick(() => {
  if (!shuttingDown) {
    void runLoopOnce();
  }
});

function validateEnvironment(): void {
  const ids = [
    ...[...DISCORD_APPLICATIONS.values()].map(
      (application) => [application.clientIdEnvironment, application.clientId] as const
    ),
    ['DISCORD_CLIENT_ID', FALLBACK_CLIENT_ID] as const
  ];

  for (const [name, value] of ids) {
    if (!value) {
      if (name === 'DISCORD_CLIENT_ID') {
        continue;
      }

      console.error(danger(`Missing ${name}.`));
      process.exit(1);
    }

    if (!/^\d{10,32}$/.test(value)) {
      console.error(danger(`${name} does not look like a Discord Application ID.`));
      console.error(dim('Expected a numeric client ID, not a bot token, client secret, or application name.'));
      process.exit(1);
    }
  }
}

let loopInFlight = false;
let loopQueued = false;

async function runLoopOnce(): Promise<void> {
  if (loopInFlight) {
    loopQueued = true;
    return;
  }

  loopInFlight = true;

  try {
    do {
      loopQueued = false;

      try {
        const stateTools = detectStateTools();
        const processTools = PROCESS_DETECTION_ENABLED
          ? detectActiveTools(await getProcessList(), toolProviders, {
            preferredSurfaceByFamily: PREFER_CODEX_CLI ? { codex: 'cli' } : {}
          })
          : [];
        debugLog(`Loop found ${stateTools.length} state tool(s) and ${processTools.length} process tool(s).`);
        const activeTools = await enrichToolsForPresence(
          mergeActiveTools(stateTools, processTools)
        );
        await updateActivities(activeTools);
      } catch (error) {
        logError('Loop iteration failed; continuing', error);
      }
    } while (loopQueued && !shuttingDown);
  } finally {
    loopInFlight = false;
  }
}

function stopStateWatcher(): void {
  if (stateWatchTimer) {
    clearTimeout(stateWatchTimer);
    stateWatchTimer = null;
  }

  if (stateWatcher) {
    stateWatcher.close();
    stateWatcher = null;
  }
}

function startStateWatcher(): void {
  if (stateWatcher) {
    return;
  }

  const stateDirectory = path.dirname(STATE_FILE);
  const stateFilename = path.basename(STATE_FILE);
  fs.mkdirSync(stateDirectory, { recursive: true });

  try {
    const watcher = fs.watch(
      stateDirectory,
      (_eventType: string, filename: string | Buffer | null) => {
        if (shuttingDown || (filename && filename.toString() !== stateFilename)) {
          return;
        }

        if (stateWatchTimer) {
          clearTimeout(stateWatchTimer);
        }

        stateWatchTimer = setTimeout(() => {
          stateWatchTimer = null;
          void runLoopOnce();
        }, STATE_WATCH_DEBOUNCE_MS);
      }
    );
    stateWatcher = watcher;
    log(`Watching ${STATE_FILE} for hook updates.`);

    watcher.on('error', (error: unknown) => {
      logError('State file watcher failed; polling will continue', error);
      stopStateWatcher();
    });
  } catch (error) {
    logError('Could not watch the state file; polling will continue', error);
    stopStateWatcher();
  }
}

function startPolling(): void {
  if (pollTimer) {
    return;
  }

  startStateWatcher();
  pollTimer = setInterval(runLoopOnce, POLL_INTERVAL_MS);
  void runLoopOnce();
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  markShuttingDown();
  log(`Received ${signal}. Shutting down.`);

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopStateWatcher();

  for (const state of rpcConnections.values()) {
    cancelReconnect(state);
  }

  for (const [clientId, state] of rpcConnections) {
    try {
      if (state.ready && state.client) {
        await state.client.clearActivity();
        log(`Cleared Discord activity for ${labelForClientId(clientId)}.`);
      }
    } catch (error) {
      logError(`Failed to clear ${labelForClientId(clientId)} activity during shutdown`, error);
    }
  }

  for (const state of rpcConnections.values()) {
    try {
      if (state.client) {
        state.client.destroy();
      }
    } catch (_) {
      // Ignore shutdown cleanup errors.
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  logError('Unhandled promise rejection', error);
});
process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
});

export function startDaemon(): void {
  validateEnvironment();
  log(`Starting ${APP_TITLE} daemon.`);
  log(`Presence detail level: ${DETAIL_LEVEL}.`);
  startPolling();
}
