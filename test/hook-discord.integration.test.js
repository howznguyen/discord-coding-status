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
