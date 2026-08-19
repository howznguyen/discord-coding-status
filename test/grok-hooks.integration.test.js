'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Isolate Grok hooks config before loading the module so tests never touch ~/.grok.
process.env.DISCORD_CODING_STATUS_GROK_HOOKS_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'grok-hooks-test-')
);

const {
  GROK_HOOK_EVENTS,
  GROK_MANAGED_HOOK_MARKER,
  GROK_HOOKS_DIR,
  GROK_HOOKS_FILE,
  getManagedGrokHookStatus,
  installManagedGrokHooks,
  removeManagedGrokHooks,
  grokHookCommand,
  grokHookSessionFromArgs,
  statusFromGrokHookEvent
} = require('../dist/grok-hooks');

const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');

function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('grok hook commands stay parseable in the shell each platform uses', () => {
  // Grok has no per-platform `commandWindows` field, so `command` itself has to
  // be valid PowerShell on Windows and valid POSIX sh everywhere else.
  const windowsCommand = withPlatform('win32', () => grokHookCommand('C:\\app\\cli.js', 'PostToolUse'));
  assert.ok(windowsCommand.startsWith("& '"), 'windows command starts with the call operator');
  assert.ok(windowsCommand.includes("'C:\\app\\cli.js'"), 'script path is single-quoted');
  assert.ok(windowsCommand.includes("'--event' 'PostToolUse'"), 'event is passed as separate literals');
  assert.ok(windowsCommand.includes(GROK_MANAGED_HOOK_MARKER), 'owner marker survives quoting');
  assert.equal(windowsCommand.includes('\\"'), false, 'no cmd.exe-style escaping');

  const posixCommand = withPlatform('linux', () => grokHookCommand('/app/cli.js', 'PostToolUse'));
  assert.equal(posixCommand.startsWith('&'), false, 'posix command is not a powershell call');
  assert.ok(posixCommand.includes("'/app/cli.js' grok-hook --event PostToolUse"), posixCommand);
});

test('grok hook install writes one group per event with a grok-hook command', (t) => {
  t.after(() => fs.rmSync(GROK_HOOKS_DIR, { recursive: true, force: true }));

  const result = installManagedGrokHooks('/path/to/cli.js');
  assert.equal(result.installed, GROK_HOOK_EVENTS.length);
  assert.equal(result.hooksFile, GROK_HOOKS_FILE);
  assert.ok(fs.existsSync(GROK_HOOKS_FILE), 'expected the dedicated grok hooks file to be written');

  const raw = JSON.parse(fs.readFileSync(GROK_HOOKS_FILE, 'utf8'));
  assert.deepEqual(Object.keys(raw.hooks).sort(), [...GROK_HOOK_EVENTS].sort());

  for (const eventName of GROK_HOOK_EVENTS) {
    const groups = raw.hooks[eventName];
    assert.ok(Array.isArray(groups) && groups.length === 1, `expected one group for ${eventName}`);
    const hook = groups[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.match(hook.command, /grok-hook/);
    assert.ok(hook.command.includes(eventName), `command references ${eventName}`);
    assert.ok(hook.command.includes(GROK_MANAGED_HOOK_MARKER), 'command carries the owner marker');

    if (process.platform === 'win32') {
      // Grok runs hooks through PowerShell on Windows, which reports a
      // ParserError unless the call operator invokes the quoted interpreter.
      assert.ok(hook.command.startsWith("& '"), 'windows command uses the call operator');
    } else {
      assert.ok(hook.command.includes(`--event ${eventName}`), `command passes --event ${eventName}`);
    }
    assert.equal(hook.timeout, 5);
  }

  const status = getManagedGrokHookStatus();
  assert.equal(status.installed, true);
  assert.equal(status.managedCount, GROK_HOOK_EVENTS.length);
  assert.deepEqual(status.missingEvents, []);
  assert.deepEqual(status.duplicateEvents, []);
  assert.deepEqual(status.unexpectedEvents, []);
});

test('grok hook removal deletes the dedicated file and reports a clean status', (t) => {
  installManagedGrokHooks('/path/to/cli.js');
  const removed = removeManagedGrokHooks();
  assert.equal(removed.removed, GROK_HOOK_EVENTS.length);
  assert.equal(fs.existsSync(GROK_HOOKS_FILE), false);
  const status = getManagedGrokHookStatus();
  assert.equal(status.installed, false);
  assert.equal(status.managedCount, 0);
  assert.deepEqual(status.missingEvents, [...GROK_HOOK_EVENTS]);
});

test('grok hook events report a session to the daemon, map PreToolUse, and clear on SessionEnd', async (t) => {
  const { env, rpcLogFile } = createTestEnvironment(t);
  const daemon = startDaemon(t, env);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await runCli(
    ['grok-hook', '--event', 'PreToolUse'],
    env,
    15000,
    JSON.stringify({
      hookEventName: 'pre_tool_use',
      sessionId: 'grok-session',
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      permissionMode: 'bypassPermissions',
      toolName: 'run_terminal_command',
      timestamp: Date.now()
    })
  );

  const activity = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details.includes('Running run_terminal_command')
    ),
    'the PreToolUse activity to reach Discord RPC'
  );

  const state = JSON.parse((await runCli(['state'], env)).stdout);
  const session = state.sessions['grok-session'];
  assert.equal(session.tool, 'grok');
  assert.equal(session.surface, 'cli');
  assert.equal(session.status, 'running');
  assert.equal(session.activity, 'Running run_terminal_command');
  assert.equal(session.cwd, process.cwd());
  assert.equal(session.model, undefined, 'grok hook input carries no model');

  await runCli(
    ['grok-hook', '--event', 'SessionEnd'],
    env,
    15000,
    JSON.stringify({
      hookEventName: 'session_end',
      sessionId: 'grok-session',
      cwd: process.cwd()
    })
  );

  await waitFor(
    () => readRpcEvents(rpcLogFile).find((event) => event.method === 'clearActivity'),
    'the terminal grok session to clear Discord RPC'
  );

  const afterState = JSON.parse((await runCli(['state'], env)).stdout);
  assert.equal(afterState.sessions['grok-session'], undefined);
  assert.equal(daemon.output().stderr, '');
});

test('grok stop events map to waiting_input and invalid stdin still exits 0', async (t) => {
  const { env } = createTestEnvironment(t);

  const mappings = [
    ['Stop', 'stop', 'waiting_input'],
    ['StopCancelled', 'stop_cancelled', 'waiting_input'],
    ['StopFailure', 'stop_failure', 'waiting_input']
  ];
  const sessionIds = mappings.map(([event]) => `grok-${event.toLowerCase()}`);

  for (let index = 0; index < mappings.length; index += 1) {
    const [event, hookEventName, expectedStatus] = mappings[index];
    const sessionId = sessionIds[index];
    await runCli(
      ['grok-hook', '--event', event],
      env,
      15000,
      JSON.stringify({ hookEventName, sessionId, cwd: process.cwd() })
    );
    const state = JSON.parse((await runCli(['state'], env)).stdout);
    assert.equal(state.sessions[sessionId].status, expectedStatus);
  }

  // Invalid stdin must never cause a non-zero exit, so runCli resolving proves exit 0.
  await runCli(['grok-hook', '--event', 'UserPromptSubmit'], env, 15000, '{ not valid json');

  assert.equal(statusFromGrokHookEvent('SessionStart'), 'running');
  assert.equal(statusFromGrokHookEvent('UserPromptSubmit'), 'running');
  assert.equal(statusFromGrokHookEvent('PreToolUse'), 'running');
  assert.equal(statusFromGrokHookEvent('PostToolUse'), 'running');
  assert.equal(statusFromGrokHookEvent('Stop'), 'waiting_input');
  assert.equal(statusFromGrokHookEvent('StopCancelled'), 'waiting_input');
  assert.equal(statusFromGrokHookEvent('StopFailure'), 'waiting_input');
  assert.equal(statusFromGrokHookEvent('SessionEnd'), 'stopped');
});

test('grok PostToolUse maps to Finished <tool> and SessionStart stays active', async (t) => {
  const { env } = createTestEnvironment(t);

  const post = grokHookSessionFromArgs({ event: 'PostToolUse' }).activity;
  assert.equal(post, undefined, 'no tool means no activity');

  await runCli(
    ['grok-hook', '--event', 'PostToolUse'],
    env,
    15000,
    JSON.stringify({
      hookEventName: 'post_tool_use',
      sessionId: 'grok-post',
      cwd: process.cwd(),
      toolName: 'edit_file'
    })
  );
  let state = JSON.parse((await runCli(['state'], env)).stdout);
  assert.equal(state.sessions['grok-post'].status, 'running');
  assert.equal(state.sessions['grok-post'].activity, 'Finished edit_file');

  await runCli(
    ['grok-hook', '--event', 'SessionStart'],
    env,
    15000,
    JSON.stringify({ hookEventName: 'session_start', sessionId: 'grok-start', cwd: process.cwd() })
  );
  state = JSON.parse((await runCli(['state'], env)).stdout);
  assert.equal(state.sessions['grok-start'].status, 'running');
});

test('grok resolves model and effort from cache and config when available', async (t) => {
  const { env } = createTestEnvironment(t);
  const grokDir = path.dirname(GROK_HOOKS_DIR);
  fs.mkdirSync(grokDir, { recursive: true });
  t.after(() => {
    try {
      fs.rmSync(path.join(grokDir, 'models_cache.json'), { force: true });
    } catch (_) {}
  });

  fs.writeFileSync(
    path.join(grokDir, 'models_cache.json'),
    JSON.stringify({
      models: {
        'grok-4.6': {
          info: {
            id: 'grok-4.6',
            name: 'Grok 4.6',
            reasoning_effort: 'high'
          }
        }
      }
    })
  );

  await runCli(
    ['grok-hook', '--event', 'SessionStart'],
    env,
    15000,
    JSON.stringify({ hookEventName: 'session_start', sessionId: 'grok-model-test', cwd: process.cwd() })
  );
  const state = JSON.parse((await runCli(['state'], env)).stdout);
  assert.equal(state.sessions['grok-model-test'].tool, 'grok');
  assert.equal(state.sessions['grok-model-test'].model, 'Grok 4.6');
  assert.equal(state.sessions['grok-model-test'].effort, 'high');
});

test('claude-hook delegates to grok when invoked in grok environment', async (t) => {
  const { env } = createTestEnvironment(t);
  const grokEnv = {
    ...env,
    GROK_SESSION_ID: 'grok-compat-session'
  };

  await runCli(
    ['claude-hook', '--event', 'UserPromptSubmit'],
    grokEnv,
    15000,
    JSON.stringify({ hook_event_name: 'user_prompt_submit', session_id: 'grok-compat-session', cwd: process.cwd() })
  );
  const state = JSON.parse((await runCli(['state'], env)).stdout);
  assert.equal(state.sessions['grok-compat-session'].tool, 'grok');
  assert.equal(state.sessions['grok-compat-session'].status, 'running');
});
