'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');
const { version: PACKAGE_VERSION } = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const FETCH_MOCK = path.join(__dirname, 'fixtures', 'mock-claude-fetch.cjs');
const TEST_ACCESS_TOKEN = 'claude-test-access-token-private';

function writeClaudeCredentials(claudeConfigDir) {
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  fs.writeFileSync(path.join(claudeConfigDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: TEST_ACCESS_TOKEN,
      refreshToken: 'claude-test-refresh-token-private',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile'],
      subscriptionType: 'pro'
    }
  }));
}

function claudeTestEnvironment(baseEnv, directory, overrides = {}) {
  const claudeConfigDir = path.join(directory, '.claude');
  const requestLogFile = path.join(directory, 'claude-requests.jsonl');
  const nodeOptions = [baseEnv.NODE_OPTIONS, `--require=${FETCH_MOCK}`]
    .filter(Boolean)
    .join(' ');
  writeClaudeCredentials(claudeConfigDir);

  return {
    claudeConfigDir,
    requestLogFile,
    env: {
      ...baseEnv,
      HOME: directory,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      CLAUDE_CODE_USE_MANTLE: '',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '',
      DISCORD_CODING_STATUS_CLAUDE_KEYCHAIN: 'off',
      DISCORD_CODING_STATUS_MOCK_CLAUDE_FETCH: '1',
      DISCORD_CODING_STATUS_CLAUDE_REQUEST_LOG_FILE: requestLogFile,
      NODE_OPTIONS: nodeOptions,
      ...overrides
    }
  };
}

function runCliRaw(args, env, input = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    if (input !== null) {
      child.stdin.end(input);
    }
  });
}

function requestLog(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('quota --tool claude uses the fixed OAuth usage host and fails closed for API-key mode', async (t) => {
  const { directory, env: baseEnv } = createTestEnvironment(t);
  const { claudeConfigDir, env, requestLogFile } = claudeTestEnvironment(baseEnv, directory);
  const success = await runCli(['quota', '--tool', 'claude'], env);

  assert.equal(success.stdout.trim(), 'Pro • 5h 75% • weekly 60%');
  assert.equal(success.stderr, '');
  assert.deepEqual(requestLog(requestLogFile), [{
    url: 'https://api.anthropic.com/api/oauth/usage',
    method: 'GET',
    hasBearerToken: true,
    beta: 'oauth-2025-04-20',
    userAgent: `claude-code/${PACKAGE_VERSION} (discord-coding-status)`
  }]);

  const ineligibleModes = [
    {
      env: { ANTHROPIC_API_KEY: 'custom-provider-key-private' },
      diagnostic: /hidden while Anthropic API-key mode is active/i
    },
    {
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' },
      diagnostic: /hidden while a custom Claude provider is active/i
    },
    {
      env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      diagnostic: /hidden while a custom Claude provider is active/i
    },
    {
      env: { CLAUDE_CODE_USE_MANTLE: '1' },
      diagnostic: /hidden while a custom Claude provider is active/i
    },
    {
      env: { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' },
      diagnostic: /hidden while a custom Claude provider is active/i
    }
  ];
  for (const ineligible of ineligibleModes) {
    const unavailable = await runCliRaw(['quota', '--tool', 'claude'], {
      ...env,
      ...ineligible.env
    });
    assert.equal(unavailable.code, 1);
    assert.equal(unavailable.stdout, '');
    assert.match(unavailable.stderr, ineligible.diagnostic);
    assert.doesNotMatch(unavailable.stderr, /custom-provider-key-private|claude-test-access-token-private/);
  }
  fs.writeFileSync(path.join(claudeConfigDir, 'settings.json'), JSON.stringify({
    apiKeyHelper: '/usr/local/bin/read-anthropic-key'
  }));
  const helperUnavailable = await runCliRaw(['quota', '--tool', 'claude'], env);
  assert.equal(helperUnavailable.code, 1);
  assert.equal(helperUnavailable.stdout, '');
  assert.match(helperUnavailable.stderr, /hidden while Anthropic API-key mode is active/i);
  assert.doesNotMatch(helperUnavailable.stderr, /read-anthropic-key|claude-test-access-token-private/);
  assert.equal(requestLog(requestLogFile).length, 1, 'custom Claude modes must not make an OAuth usage request');
});

test('native Claude hooks update raw model immediately while slow quota refresh stays in background', async (t) => {
  const { directory, env: baseEnv, rpcLogFile, stateFile } = createTestEnvironment(t);
  const { env, requestLogFile } = claudeTestEnvironment(baseEnv, directory, {
    DISCORD_CODING_STATUS_MOCK_CLAUDE_DELAY_MS: '2000'
  });
  const privatePrompt = 'private-hook-prompt-must-not-persist';
  const privateResponse = 'private-transcript-response-must-not-persist';
  const transcriptPath = path.join(directory, 'claude-session.jsonl');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: privateResponse }]
    }
  })}\n`);
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  const startedAt = Date.now();
  await runCli(
    ['claude-hook', '--event', 'UserPromptSubmit'],
    env,
    15000,
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-native-session',
      cwd: process.cwd(),
      transcript_path: transcriptPath,
      prompt: privatePrompt
    })
  );

  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.state.includes('claude-sonnet-4-6')
    ),
    'the Claude model to reach Discord before quota responds',
    1200
  );
  assert.ok(Date.now() - startedAt < 1500, 'model activity should not wait for the slow quota response');

  const enriched = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.state.includes('claude-sonnet-4-6')
        && event.activity.state.includes('Pro • 5h 75% • weekly 60%')
    ),
    'the background Claude quota to enrich Discord',
    5000
  );
  assert.equal(enriched.clientId, '1521213655092428923');

  const stateText = fs.readFileSync(stateFile, 'utf8');
  const state = JSON.parse(stateText);
  assert.equal(state.sessions['claude-native-session'].model, 'claude-sonnet-4-6');
  assert.equal(state.sessions['claude-native-session'].claude_quota_eligible, true);
  assert.doesNotMatch(stateText, new RegExp(`${privatePrompt}|${privateResponse}|${TEST_ACCESS_TOKEN}`));

  fs.writeFileSync(transcriptPath, '{"type":"assistant","message":');
  await runCli(
    ['claude-hook', '--event', 'PostToolUse'],
    env,
    15000,
    JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'claude-native-session',
      cwd: process.cwd(),
      transcript_path: transcriptPath
    })
  );
  const laggingState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(laggingState.sessions['claude-native-session'].model, 'claude-sonnet-4-6');

  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-4-6', content: [] }
  })}\n`);
  await runCli(
    ['claude-hook', '--event', 'PostToolUse'],
    env,
    15000,
    JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'claude-native-session',
      cwd: process.cwd(),
      transcript_path: transcriptPath
    })
  );
  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.state.includes('claude-opus-4-6')
    ),
    'the changed Claude model to reach Discord'
  );

  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'replacement-account-token-private',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max'
    }
  }));
  await runCli(
    ['claude-hook', '--event', 'PostToolUse', '--activity', 'Changed account model only'],
    env,
    15000,
    JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'claude-native-session',
      cwd: process.cwd(),
      model: 'claude-opus-4-6'
    })
  );
  const changedAccountActivity = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details.includes('Changed account model only')
    ),
    'the changed-account model-only activity to reach Discord'
  );
  assert.match(changedAccountActivity.activity.state, /claude-opus-4-6/);
  assert.doesNotMatch(changedAccountActivity.activity.state, /Pro|5h 75%|weekly 60%/);

  await runCli(
    ['claude-hook', '--event', 'PostToolUse', '--activity', 'Custom provider model only'],
    {
      ...env,
      ANTHROPIC_API_KEY: 'active-custom-provider-key-private'
    },
    15000,
    JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'claude-native-session',
      cwd: process.cwd(),
      model: 'gateway-model-alias'
    })
  );
  const customProviderActivity = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details.includes('Custom provider model only')
    ),
    'the custom-provider model-only activity to reach Discord'
  );
  assert.match(customProviderActivity.activity.state, /gateway-model-alias/);
  assert.doesNotMatch(customProviderActivity.activity.state, /Pro|5h 75%|weekly 60%/);
  const customProviderState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(customProviderState.sessions['claude-native-session'].claude_quota_eligible, false);

  const requests = requestLog(requestLogFile);
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(requests).includes(TEST_ACCESS_TOKEN), false);
  assert.doesNotMatch(
    daemon.output().stdout + daemon.output().stderr,
    new RegExp(`${privatePrompt}|${privateResponse}|${TEST_ACCESS_TOKEN}|replacement-account-token-private|active-custom-provider-key-private`)
  );
});

test('Claude hook CLI lifecycle preserves unrelated settings and removes only managed hooks', async (t) => {
  const { directory, env: baseEnv } = createTestEnvironment(t);
  const claudeConfigDir = path.join(directory, '.claude');
  const settingsFile = path.join(claudeConfigDir, 'settings.json');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    permissions: { allow: ['Read'] },
    hooks: {
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node keep-me.js' }] }]
    }
  }));
  const env = {
    ...baseEnv,
    HOME: directory,
    CLAUDE_CONFIG_DIR: claudeConfigDir
  };

  await runCli(['setup-claude-hooks'], env, 30000);
  const installedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(installedSettings.permissions, { allow: ['Read'] });
  assert.equal(installedSettings.hooks.PreToolUse[0].hooks[0].command, 'node keep-me.js');
  assert.equal(JSON.stringify(installedSettings).match(/--managed-by=discord-coding-status/g).length, 9);

  const statusResult = await runCli(['claude-hooks-status'], env);
  const status = JSON.parse(statusResult.stdout);
  assert.equal(status.installed, true);
  assert.equal(status.managedCount, 9);
  assert.deepEqual(status.missingEvents, []);

  await runCli(['uninstall-claude-hooks'], env);
  const uninstalledSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(uninstalledSettings.permissions, { allow: ['Read'] });
  assert.equal(uninstalledSettings.hooks.PreToolUse[0].hooks[0].command, 'node keep-me.js');
  assert.equal(JSON.stringify(uninstalledSettings).includes('--managed-by=discord-coding-status'), false);
});
