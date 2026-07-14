'use strict';

const assert = require('node:assert/strict');
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
