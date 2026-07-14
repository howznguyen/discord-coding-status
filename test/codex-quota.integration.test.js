'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');

async function startUsageServer(t, responseDelayMs = 0) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      accountId: request.headers['chatgpt-account-id'],
      url: request.url
    });

    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 45,
            limit_window_seconds: 604800
          },
          secondary_window: null
        }
      }));
    }, responseDelayMs);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests
  };
}

function writeTestAuth(directory) {
  const authFile = path.join(directory, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({
    tokens: {
      access_token: 'test-access-token',
      account_id: 'test-account-id'
    }
  }));
  return authFile;
}

test('OAuth quota labels the current primary 7-day window as weekly', async (t) => {
  const { directory, env } = createTestEnvironment(t);
  const usageServer = await startUsageServer(t);
  const authFile = writeTestAuth(directory);
  const result = await runCli(['quota', '--source', 'oauth'], {
    ...env,
    DISCORD_CODING_STATUS_CODEX_AUTH_FILE: authFile,
    DISCORD_CODING_STATUS_CODEX_API_BASE_URL: usageServer.baseUrl
  });

  assert.equal(result.stdout.trim(), 'Pro • weekly 55%');
  assert.equal(usageServer.requests.length, 1);
  assert.equal(usageServer.requests[0].authorization, 'Bearer test-access-token');
  assert.equal(usageServer.requests[0].accountId, 'test-account-id');
  assert.equal(usageServer.requests[0].url, '/wham/usage');
});

test('a slow OAuth quota request does not block a hook update to Discord', async (t) => {
  const { directory, env, rpcLogFile } = createTestEnvironment(t);
  const usageServer = await startUsageServer(t, 2000);
  const authFile = writeTestAuth(directory);
  const daemonEnv = {
    ...env,
    DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE: 'oauth',
    DISCORD_CODING_STATUS_CODEX_AUTH_FILE: authFile,
    DISCORD_CODING_STATUS_CODEX_API_BASE_URL: usageServer.baseUrl,
    DISCORD_CODING_STATUS_USAGE_TIMEOUT_MS: '5000'
  };
  const daemon = startDaemon(t, daemonEnv);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await runCli([
    'hook',
    '--tool', 'codex',
    '--surface', 'cli',
    '--status', 'running',
    '--session-id', 'slow-quota-session',
    '--cwd', process.cwd(),
    '--activity', 'Non-blocking quota verification'
  ], daemonEnv);

  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details.includes('Non-blocking quota verification')
    ),
    'the hook activity to reach Discord before quota responds',
    1200
  );

  const quotaActivity = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.state === 'Pro • weekly 55%'
    ),
    'the background quota refresh to update Discord',
    5000
  );

  assert.equal(quotaActivity.clientId, '1517375602662051900');
  assert.equal(usageServer.requests.length, 1);
  assert.equal(daemon.output().stderr, '');
});
