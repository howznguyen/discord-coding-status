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

test('concurrent hook writes remain atomic and converge on Discord', { timeout: 120000 }, async (t) => {
  const iterations = Number(process.env.DISCORD_CODING_STATUS_STRESS_ITERATIONS || 24);
  const { directory, env, rpcLogFile, stateFile } = createTestEnvironment(t, {
    DISCORD_CODING_STATUS_STATE_LOCK_TIMEOUT_MS: '15000'
  });
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await Promise.all(Array.from({ length: iterations }, (_, index) => runCli([
    'hook',
    '--tool', 'codex',
    '--surface', 'cli',
    '--status', 'running',
    '--session-id', `stress-${index}`,
    '--cwd', path.join(directory, `workspace-${index}`),
    '--activity', `Concurrent activity ${index}`
  ], env, 30000)));

  const stateAfterBurst = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(Object.keys(stateAfterBurst.sessions).length, iterations);

  await runCli([
    'hook',
    '--tool', 'codex',
    '--surface', 'cli',
    '--status', 'running',
    '--session-id', 'stress-final',
    '--cwd', process.cwd(),
    '--activity', 'Stress final convergence'
  ], env);

  const finalEvent = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details.includes('Stress final convergence')
    ),
    'the final state to converge on Discord RPC',
    15000
  );
  assert.equal(finalEvent.clientId, '1517375602662051900');

  const finalState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(Object.keys(finalState.sessions).length, iterations + 1);
  assert.equal(finalState.sessions['stress-final'].activity, 'Stress final convergence');
  assert.equal(daemon.output().stderr, '');
});
