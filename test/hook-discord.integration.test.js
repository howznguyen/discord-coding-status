'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');

test('hook changes update and clear Discord Rich Presence without waiting for polling', async (t) => {
  const { env, rpcLogFile } = createTestEnvironment(t);
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  const commonArgs = [
    'hook',
    '--tool', 'codex',
    '--surface', 'cli',
    '--status', 'running',
    '--session-id', 'integration-session',
    '--cwd', process.cwd()
  ];

  await runCli([...commonArgs, '--activity', 'Integration first activity'], env);
  const first = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details.includes('Integration first activity')
    ),
    'the first hook activity to reach Discord RPC'
  );
  assert.equal(first.clientId, '1517375602662051900');

  await runCli([...commonArgs, '--activity', 'Integration changed activity'], env);
  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details.includes('Integration changed activity')
    ),
    'the changed hook activity to reach Discord RPC'
  );

  await runCli(['clear', '--session-id', 'integration-session'], env);
  await waitFor(
    () => readRpcEvents(rpcLogFile).find((event) => event.method === 'clearActivity'),
    'the cleared hook session to clear Discord RPC'
  );

  const setActivities = readRpcEvents(rpcLogFile)
    .filter((event) => event.method === 'setActivity');
  assert.ok(setActivities.length >= 2, 'expected a Discord update for both hook states');
  assert.equal(daemon.output().stderr, '');
});

test('Codex hook shows the active model and reasoning effort from transcript metadata', async (t) => {
  const { directory, env, rpcLogFile } = createTestEnvironment(t);
  const transcriptPath = path.join(directory, 'codex-session.jsonl');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'turn_context',
    payload: {
      model: 'gpt-5.6-sol',
      effort: 'xhigh'
    }
  })}\n`);
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await runCli(
    ['codex-hook', '--event', 'UserPromptSubmit'],
    env,
    15000,
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'model-effort-session',
      cwd: process.cwd(),
      transcript_path: transcriptPath,
      model: 'gpt-5.6-sol',
      prompt: 'test prompt'
    })
  );

  const activity = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.state.includes('gpt-5.6-sol · xhigh')
    ),
    'the model and reasoning effort to reach Discord RPC'
  );
  assert.match(activity.activity.state, /^gpt-5\.6-sol · xhigh \|/);

  const stateResult = await runCli(['state'], env);
  const state = JSON.parse(stateResult.stdout);
  assert.equal(state.sessions['model-effort-session'].model, 'gpt-5.6-sol');
  assert.equal(state.sessions['model-effort-session'].effort, 'xhigh');
  assert.equal(daemon.output().stderr, '');
});

test('display layout can hide blocks while showing project, context, and package', async (t) => {
  const { env, rpcLogFile } = createTestEnvironment(t, {
    DISCORD_CODING_STATUS_SHOW_ACTIVITY: 'false',
    DISCORD_CODING_STATUS_SHOW_PROJECT: 'true',
    DISCORD_CODING_STATUS_SHOW_MODEL: 'false',
    DISCORD_CODING_STATUS_SHOW_QUOTA: 'false',
    DISCORD_CODING_STATUS_SHOW_CONTEXT: 'true',
    DISCORD_CODING_STATUS_SHOW_PACKAGE: 'true'
  });
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await runCli([
    'hook',
    '--tool', 'codex',
    '--surface', 'cli',
    '--status', 'running',
    '--session-id', 'display-layout-session',
    '--cwd', process.cwd(),
    '--activity', 'This activity must be hidden',
    '--project', 'display-project',
    '--package', 'display-package',
    '--model', 'gpt-hidden',
    '--effort', 'xhigh',
    '--context', '42%'
  ], env);

  const event = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (candidate) => candidate.method === 'setActivity'
        && candidate.activity.details.includes('display-project')
    ),
    'the custom display layout to reach Discord RPC'
  );

  assert.doesNotMatch(event.activity.details, /This activity must be hidden/);
  assert.match(event.activity.state, /^ctx 42% \| pkg display-package$/);
  assert.doesNotMatch(event.activity.state, /gpt-hidden|quota/i);
  assert.equal(daemon.output().stderr, '');
});

test('normal activity style replaces humorous Codex hook messages', async (t) => {
  const { env } = createTestEnvironment(t, {
    DISCORD_CODING_STATUS_ACTIVITY_STYLE: 'normal'
  });

  await runCli(
    ['codex-hook', '--event', 'PreToolUse'],
    env,
    15000,
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'normal-activity-session',
      cwd: process.cwd(),
      tool_name: 'Bash'
    })
  );

  const stateResult = await runCli(['state'], env);
  const state = JSON.parse(stateResult.stdout);
  assert.equal(state.sessions['normal-activity-session'].activity, 'Using Bash');
});

test('context display rejects free-form text instead of exposing it to Discord', async (t) => {
  const { env, rpcLogFile } = createTestEnvironment(t, {
    DISCORD_CODING_STATUS_SHOW_MODEL: 'false',
    DISCORD_CODING_STATUS_SHOW_QUOTA: 'false',
    DISCORD_CODING_STATUS_SHOW_CONTEXT: 'true',
    DISCORD_CODING_STATUS_SHOW_PACKAGE: 'false'
  });
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await runCli([
    'hook',
    '--tool', 'codex',
    '--status', 'running',
    '--session-id', 'private-context-session',
    '--cwd', process.cwd(),
    '--activity', 'Context privacy check',
    '--context', 'secret prompt text 42%'
  ], env);

  const event = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (candidate) => candidate.method === 'setActivity'
        && candidate.activity.details.includes('Context privacy check')
    ),
    'the sanitized context activity to reach Discord RPC'
  );

  assert.equal(event.activity.state, undefined);
  assert.doesNotMatch(JSON.stringify(event.activity), /secret prompt text/);
  assert.equal(daemon.output().stderr, '');
});
