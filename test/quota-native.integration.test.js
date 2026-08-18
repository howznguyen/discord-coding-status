'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const {
  createTestEnvironment,
  runCli
} = require('./helpers');

async function startJsonServer(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        body
      });
      handler(request, response, body);
    });
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

function writeGrokAuth(file, overrides = {}) {
  fs.writeFileSync(file, JSON.stringify({
    'https://auth.x.ai::test-client': {
      key: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      ...overrides
    }
  }));
}

test('grok quota CLI reports the weekly pool and pay-as-you-go from the billing endpoint', async (t) => {
  const { env, directory } = createTestEnvironment(t);
  const authFile = path.join(directory, 'grok-auth.json');
  const { baseUrl, requests } = await startJsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-15T00:00:00Z',
          end: '2026-08-22T00:00:00Z'
        },
        creditUsagePercent: 62,
        onDemandCap: { val: 2500 },
        onDemandUsed: { val: 1200 },
        prepaidBalance: { val: 500 },
        isUnifiedBillingUser: true
      }
    }));
  });

  writeGrokAuth(authFile);

  const result = await runCli(['quota', '--tool', 'grok'], {
    ...env,
    DISCORD_CODING_STATUS_GROK_AUTH_FILE: authFile,
    DISCORD_CODING_STATUS_GROK_BILLING_URL: `${baseUrl}/billing?format=credits`,
    DISCORD_CODING_STATUS_GROK_REFRESH_URL: `${baseUrl}/refresh`
  });

  assert.equal(result.stdout.trim(), 'Grok • Weekly 62% • PAYG 2500 cap • on-demand used 1200 • prepaid 500');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, 'Bearer test-access-token');
});

test('grok quota refreshes an expired token and persists the rotated credentials', async (t) => {
  const { env, directory } = createTestEnvironment(t);
  const authFile = path.join(directory, 'grok-auth.json');
  const { baseUrl, requests } = await startJsonServer(t, (request, response) => {
    if (request.url.startsWith('/refresh')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        access_token: 'rotated-token',
        refresh_token: 'rotated-refresh',
        expires_in: 3600
      }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-15T00:00:00Z',
          end: '2026-08-22T00:00:00Z'
        },
        isUnifiedBillingUser: true,
        onDemandCap: { val: 0 }
      }
    }));
  });

  writeGrokAuth(authFile, {
    key: 'expired-token',
    refresh_token: 'old-refresh',
    expires_at: new Date(Date.now() - 60 * 1000).toISOString()
  });

  const result = await runCli(['quota', '--tool', 'grok'], {
    ...env,
    DISCORD_CODING_STATUS_GROK_AUTH_FILE: authFile,
    DISCORD_CODING_STATUS_GROK_BILLING_URL: `${baseUrl}/billing`,
    DISCORD_CODING_STATUS_GROK_REFRESH_URL: `${baseUrl}/refresh`
  });

  assert.equal(result.stdout.trim(), 'Grok • Weekly 0% • PAYG off');
  const billingRequest = requests.find((request) => request.url.startsWith('/billing'));
  assert.ok(billingRequest, 'expected a billing request after refresh');
  assert.equal(billingRequest.authorization, 'Bearer rotated-token');

  const saved = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  const entry = saved['https://auth.x.ai::test-client'];
  assert.equal(entry.key, 'rotated-token');
  assert.equal(entry.refresh_token, 'rotated-refresh');
});

test('grok quota fails when no grok login exists', async (t) => {
  const { env, directory } = createTestEnvironment(t);
  const authFile = path.join(directory, 'missing-grok-auth.json');
  const { baseUrl } = await startJsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ config: {} }));
  });

  await assert.rejects(
    runCli(['quota', '--tool', 'grok'], {
      ...env,
      DISCORD_CODING_STATUS_GROK_AUTH_FILE: authFile,
      DISCORD_CODING_STATUS_GROK_BILLING_URL: `${baseUrl}/billing`,
      DISCORD_CODING_STATUS_GROK_REFRESH_URL: `${baseUrl}/refresh`
    }),
    /grok quota unavailable/
  );
});

test('opencode quota CLI reports Go windows from the usage endpoint', async (t) => {
  const { env } = createTestEnvironment(t);
  const { baseUrl, requests } = await startJsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 43, resetsAt: '2026-08-18T12:22:41.125Z' },
        weekly: { status: 'ok', percent: 90, resetsAt: '2026-08-24T00:00:00.125Z' },
        monthly: { status: 'ok', percent: 59, resetsAt: '2026-09-06T16:42:15.125Z' }
      }
    }));
  });

  const result = await runCli(['quota', '--tool', 'opencode'], {
    ...env,
    DISCORD_CODING_STATUS_OPENCODE_API_KEY: 'sk-test123',
    DISCORD_CODING_STATUS_OPENCODE_API_BASE_URL: baseUrl
  });

  assert.equal(result.stdout.trim(), 'OpenCode Go • 5h 57% • weekly 10% • month 41%');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, 'Bearer sk-test123');
});

test('opencode quota reads the opencode-go key from the local auth.json', async (t) => {
  const { env, directory } = createTestEnvironment(t);
  const authFile = path.join(directory, 'opencode-auth.json');
  const { baseUrl, requests } = await startJsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: 'x' },
        weekly: { status: 'ok', percent: 0, resetsAt: 'x' },
        monthly: { status: 'ok', percent: 0, resetsAt: 'x' }
      }
    }));
  });

  fs.writeFileSync(authFile, JSON.stringify({
    'opencode-go': { type: 'api', key: 'sk-opencode-go-secret' }
  }));

  const result = await runCli(['quota', '--tool', 'opencode'], {
    ...env,
    DISCORD_CODING_STATUS_OPENCODE_AUTH_FILE: authFile,
    DISCORD_CODING_STATUS_OPENCODE_API_BASE_URL: baseUrl
  });

  assert.equal(result.stdout.trim(), 'OpenCode Go • 5h 100% • weekly 100% • month 100%');
  assert.equal(requests[0].authorization, 'Bearer sk-opencode-go-secret');
});
