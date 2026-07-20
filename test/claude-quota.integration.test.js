const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const modulePath = process.env.CLAUDE_QUOTA_MODULE_PATH
  ? path.resolve(process.env.CLAUDE_QUOTA_MODULE_PATH)
  : path.resolve(__dirname, '../dist/claude-quota.js');
const {
  CLAUDE_REFRESH_URL,
  CLAUDE_USAGE_BETA,
  CLAUDE_USAGE_URL,
  ClaudeQuotaEngine,
  claudeCredentialGeneration,
  createClaudeCredentialStore,
  evaluateClaudeQuotaEligibility,
  mergeClaudeCredentialRotation
} = require(modulePath);

function oauthCredential({
  accessToken,
  refreshToken = null,
  expiresAt = Date.now() + 60 * 60_000,
  scopes = ['user:inference', 'user:profile'],
  accountId = null,
  subscriptionType = 'max'
}) {
  return {
    unrelatedSetting: true,
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes,
      accountId,
      subscriptionType
    }
  };
}

function usage(fiveHour = 25, sevenDay = 40) {
  return {
    five_hour: {
      utilization: fiveHour,
      resets_at: '2026-07-18T10:00:00Z'
    },
    seven_day: {
      utilization: sevenDay,
      resets_at: '2026-07-25T10:00:00Z'
    }
  };
}

function createMemoryCredentials(initial) {
  const values = { keychain: null, file: null, ...initial };
  const writes = [];
  let rejectPersistence = false;
  const adapters = {};

  for (const source of ['keychain', 'file']) {
    adapters[source] = {
      async read() {
        return values[source];
      },
      async compareAndSwap(expectedGeneration, update) {
        if (
          rejectPersistence
          || claudeCredentialGeneration(values[source]) !== expectedGeneration
        ) {
          return false;
        }
        const nextValue = update(values[source]);
        values[source] = nextValue;
        writes.push({ source, value: nextValue });
        return true;
      }
    };
  }

  return {
    store: createClaudeCredentialStore(adapters),
    values,
    writes,
    rejectNextPersistence() {
      rejectPersistence = true;
    }
  };
}

test('maps subscription usage to remaining percentages and prefers Keychain', async () => {
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'keychain-access', accountId: 'account-a' }),
    file: oauthCredential({ accessToken: 'file-access', accountId: 'account-b' })
  });
  const requests = [];
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    now: () => Date.parse('2026-07-18T06:00:00Z'),
    http: async (request) => {
      requests.push(request);
      return { status: 200, body: usage() };
    }
  });

  const result = await engine.getQuota({ mode: 'subscription-oauth' });

  assert.equal(result.status, 'fresh');
  assert.equal(result.source, 'keychain');
  assert.equal(result.quota.text, 'Max • 5h 75% • weekly 60%');
  assert.deepEqual(result.quota.fiveHour, {
    remainingPercent: 75,
    resetsAt: '2026-07-18T10:00:00Z'
  });
  assert.deepEqual(result.quota.sevenDay, {
    remainingPercent: 60,
    resetsAt: '2026-07-25T10:00:00Z'
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, CLAUDE_USAGE_URL);
  assert.equal(requests[0].redirect, 'error');
  assert.equal(requests[0].headers.Authorization, 'Bearer keychain-access');
  assert.equal(requests[0].headers['anthropic-beta'], CLAUDE_USAGE_BETA);
  assert.match(requests[0].headers['User-Agent'], /claude-code/i);
});

test('falls back from an auth-failed Keychain credential to the file credential', async () => {
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'expired-keychain', accountId: 'account-a' }),
    file: oauthCredential({ accessToken: 'working-file', accountId: 'account-b', subscriptionType: 'pro' })
  });
  const attempts = [];
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    http: async (request) => {
      attempts.push(request.headers.Authorization);
      return request.headers.Authorization === 'Bearer expired-keychain'
        ? { status: 401 }
        : { status: 200, body: usage(10, 20) };
    }
  });

  const result = await engine.getQuota({ mode: 'subscription-oauth' });

  assert.equal(result.status, 'fresh');
  assert.equal(result.source, 'file');
  assert.equal(result.quota.text, 'Pro • 5h 90% • weekly 80%');
  assert.deepEqual(attempts, ['Bearer expired-keychain', 'Bearer working-file']);
});

test('missing user:profile omits quota without trying the file fallback', async () => {
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'limited', scopes: ['user:inference'] }),
    file: oauthCredential({ accessToken: 'file-access' })
  });
  let requests = 0;
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    http: async () => {
      requests += 1;
      return { status: 200, body: usage() };
    }
  });

  const result = await engine.getQuota({ mode: 'subscription-oauth' });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'missing-profile-scope');
  assert.doesNotMatch(result.diagnostic, /limited|file-access/);
  assert.equal(requests, 0);
});

test('auto eligibility suppresses OAuth requests for API keys and custom providers', async () => {
  assert.deepEqual(
    evaluateClaudeQuotaEligibility({ ANTHROPIC_API_KEY: 'secret' }),
    { eligible: false, reason: 'ineligible-api-key' }
  );
  assert.deepEqual(
    evaluateClaudeQuotaEligibility({ ANTHROPIC_BASE_URL: 'https://gateway.example' }),
    { eligible: false, reason: 'ineligible-custom-provider' }
  );
  assert.deepEqual(
    evaluateClaudeQuotaEligibility({ CLAUDE_CODE_USE_MANTLE: '1' }),
    { eligible: false, reason: 'ineligible-custom-provider' }
  );
  assert.deepEqual(
    evaluateClaudeQuotaEligibility({ CLAUDE_CODE_USE_ANTHROPIC_AWS: 'true' }),
    { eligible: false, reason: 'ineligible-custom-provider' }
  );

  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'stored-oauth' })
  });
  let requests = 0;
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    environment: () => ({ ANTHROPIC_API_KEY: 'active-api-key' }),
    http: async () => {
      requests += 1;
      return { status: 200, body: usage() };
    }
  });

  const result = await engine.getQuota();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'ineligible-api-key');
  assert.equal(requests, 0);
});

test('refreshes a near-expiry token and persists rotation to its original source', async () => {
  let now = Date.parse('2026-07-18T06:00:00Z');
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: now + 30_000,
      accountId: 'account-a'
    })
  });
  const requests = [];
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    now: () => now,
    http: async (request) => {
      requests.push(request);
      if (request.url === CLAUDE_REFRESH_URL) {
        return {
          status: 200,
          body: {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600
          }
        };
      }
      return { status: 200, body: usage() };
    }
  });

  const result = await engine.getQuota({ mode: 'subscription-oauth' });

  assert.equal(result.status, 'fresh');
  assert.deepEqual(requests.map((request) => request.url), [CLAUDE_REFRESH_URL, CLAUDE_USAGE_URL]);
  assert.equal(requests[1].headers.Authorization, 'Bearer new-access');
  assert.equal(credentials.writes.length, 1);
  assert.equal(credentials.writes[0].source, 'keychain');
  assert.equal(credentials.values.keychain.unrelatedSetting, true);
  assert.equal(credentials.values.keychain.claudeAiOauth.accessToken, 'new-access');
  assert.equal(credentials.values.keychain.claudeAiOauth.refreshToken, 'new-refresh');
  assert.equal(credentials.values.keychain.claudeAiOauth.expiresAt, now + 3600_000);
});

test('retries usage once after 401 with a refreshed token', async () => {
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({
      accessToken: 'old-access',
      refreshToken: 'refresh-token',
      accountId: 'account-a'
    })
  });
  const requests = [];
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    http: async (request) => {
      requests.push(request);
      if (request.url === CLAUDE_REFRESH_URL) {
        return { status: 200, body: { access_token: 'new-access', expires_in: 3600 } };
      }
      return request.headers.Authorization === 'Bearer old-access'
        ? { status: 401 }
        : { status: 200, body: usage() };
    }
  });

  const result = await engine.getQuota({ mode: 'subscription-oauth' });

  assert.equal(result.status, 'fresh');
  assert.deepEqual(requests.map((request) => request.url), [
    CLAUDE_USAGE_URL,
    CLAUDE_REFRESH_URL,
    CLAUDE_USAGE_URL
  ]);
});

test('does not publish or persist a refreshed stale credential generation', async () => {
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({
      accessToken: 'old-access',
      refreshToken: 'refresh-token',
      expiresAt: 1,
      accountId: 'account-a'
    })
  });
  credentials.rejectNextPersistence();
  const requests = [];
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    http: async (request) => {
      requests.push(request.url);
      return request.url === CLAUDE_REFRESH_URL
        ? { status: 200, body: { access_token: 'stale-new-access' } }
        : { status: 200, body: usage() };
    }
  });

  const result = await engine.getQuota({ mode: 'subscription-oauth' });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'credential-changed');
  assert.deepEqual(requests, [CLAUDE_REFRESH_URL]);
  assert.equal(credentials.writes.length, 0);
  assert.equal(credentials.values.keychain.claudeAiOauth.accessToken, 'old-access');
});

test('keeps last-good quota on transient failure but not after engine restart', async () => {
  let now = Date.parse('2026-07-18T06:00:00Z');
  let fail = false;
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'account-a-token', accountId: 'account-a' })
  });
  const http = async () => {
    if (fail) {
      throw new Error('network unavailable');
    }
    return { status: 200, body: usage() };
  };
  const engine = new ClaudeQuotaEngine({ credentials: credentials.store, http, now: () => now });

  const first = await engine.getQuota({ mode: 'subscription-oauth' });
  assert.equal(first.status, 'fresh');

  now += 5 * 60_000 + 1;
  fail = true;
  const cached = await engine.getQuota({ mode: 'subscription-oauth' });
  assert.equal(cached.status, 'cached');
  assert.equal(cached.reason, 'transient-failure');
  assert.equal(cached.quota.text, first.quota.text);

  const restarted = new ClaudeQuotaEngine({ credentials: credentials.store, http, now: () => now });
  const afterRestart = await restarted.getQuota({ mode: 'subscription-oauth' });
  assert.equal(afterRestart.status, 'unavailable');
  assert.equal(afterRestart.reason, 'transient-failure');
});

test('honors Retry-After cooldown without another usage request', async () => {
  let now = Date.parse('2026-07-18T06:00:00Z');
  let usageCalls = 0;
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'account-a-token', accountId: 'account-a' })
  });
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    now: () => now,
    http: async () => {
      usageCalls += 1;
      if (usageCalls === 1) {
        return { status: 200, body: usage() };
      }
      if (usageCalls === 2) {
        return { status: 429, headers: { 'Retry-After': '120' } };
      }
      return { status: 200, body: usage(5, 10) };
    }
  });

  await engine.getQuota({ mode: 'subscription-oauth' });
  now += 5 * 60_000 + 1;
  const limited = await engine.getQuota({ mode: 'subscription-oauth' });
  assert.equal(limited.status, 'cached');
  assert.equal(limited.reason, 'rate-limited');
  assert.equal(usageCalls, 2);

  now += 60_000;
  const cooldown = await engine.getQuota({ mode: 'subscription-oauth' });
  assert.equal(cooldown.status, 'cached');
  assert.equal(cooldown.reason, 'rate-limited');
  assert.equal(usageCalls, 2);

  now += 61_000;
  const recovered = await engine.getQuota({ mode: 'subscription-oauth' });
  assert.equal(recovered.status, 'fresh');
  assert.equal(recovered.quota.text, 'Max • 5h 95% • weekly 90%');
  assert.equal(usageCalls, 3);
});

test('credential switching clears last-good quota and cooldown isolation', async () => {
  let now = Date.parse('2026-07-18T06:00:00Z');
  let fail = false;
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'account-a-token', accountId: 'account-a' })
  });
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    now: () => now,
    http: async (request) => {
      if (fail) {
        throw new Error('network unavailable');
      }
      return {
        status: 200,
        body: request.headers.Authorization === 'Bearer account-a-token'
          ? usage(25, 40)
          : usage(5, 10)
      };
    }
  });

  const first = await engine.getQuota({ mode: 'subscription-oauth' });
  assert.equal(first.status, 'fresh');

  credentials.values.keychain = oauthCredential({
    accessToken: 'account-b-token',
    accountId: 'account-b'
  });
  now += 1;
  fail = true;
  const switchedFailure = await engine.getQuota({ mode: 'subscription-oauth' });
  assert.equal(switchedFailure.status, 'unavailable');
  assert.equal(switchedFailure.reason, 'transient-failure');

  fail = false;
  const switchedSuccess = await engine.getQuota({ mode: 'subscription-oauth' });
  assert.equal(switchedSuccess.status, 'fresh');
  assert.equal(switchedSuccess.quota.text, 'Max • 5h 95% • weekly 90%');
});

test('does not publish quota when the ordered login changes during usage fetch', async () => {
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'account-a-token', accountId: 'account-a' })
  });
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    http: async () => {
      credentials.values.keychain = oauthCredential({
        accessToken: 'account-b-token',
        accountId: 'account-b'
      });
      return { status: 200, body: usage() };
    }
  });

  const result = await engine.getQuota({ mode: 'subscription-oauth' });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'credential-changed');
  assert.equal(result.quota, null);
});

test('coalesces concurrent refresh attempts for one effective credential', async () => {
  const credentials = createMemoryCredentials({
    keychain: oauthCredential({ accessToken: 'account-a-token', accountId: 'account-a' })
  });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const engine = new ClaudeQuotaEngine({
    credentials: credentials.store,
    http: async () => {
      calls += 1;
      await gate;
      return { status: 200, body: usage() };
    }
  });

  const first = engine.getQuota({ mode: 'subscription-oauth' });
  const second = engine.getQuota({ mode: 'subscription-oauth' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.status, 'fresh');
  assert.equal(secondResult.status, 'fresh');
  assert.equal(calls, 1);
});

test('rotation merge preserves unrelated credential fields', () => {
  const original = oauthCredential({ accessToken: 'old', refreshToken: 'refresh' });
  const next = mergeClaudeCredentialRotation(original, {
    accessToken: 'new',
    refreshToken: 'next-refresh',
    expiresAt: 123,
    scopes: ['user:profile']
  });

  assert.equal(next.unrelatedSetting, true);
  assert.equal(next.claudeAiOauth.accessToken, 'new');
  assert.equal(next.claudeAiOauth.refreshToken, 'next-refresh');
  assert.equal(next.claudeAiOauth.expiresAt, 123);
  assert.deepEqual(next.claudeAiOauth.scopes, ['user:profile']);
});

test('credential CAS rejects concurrent unrelated edits instead of clobbering them', async () => {
  const original = oauthCredential({ accessToken: 'old-access', refreshToken: 'old-refresh' });
  const expectedGeneration = claudeCredentialGeneration(original);
  let current = structuredClone(original);
  let wrote = false;
  const store = createClaudeCredentialStore({
    file: {
      async read() {
        return current;
      },
      async compareAndSwap(expected, update) {
        current = { ...current, unrelatedSetting: 'changed-by-claude-code' };
        if (claudeCredentialGeneration(current) !== expected) {
          return false;
        }
        current = update(current);
        wrote = true;
        return true;
      }
    }
  });

  const persisted = await store.persist('file', expectedGeneration, {
    accessToken: 'rotated-access',
    refreshToken: 'rotated-refresh',
    expiresAt: Date.now() + 60_000,
    scopes: ['user:profile']
  });

  assert.equal(persisted, false);
  assert.equal(wrote, false);
  assert.equal(current.unrelatedSetting, 'changed-by-claude-code');
  assert.equal(current.claudeAiOauth.accessToken, 'old-access');
});
