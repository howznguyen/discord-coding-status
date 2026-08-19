'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parsePositionals } = require('../dist/commands/args');
const { runHooksCommand } = require('../dist/commands/hooks/command');
const {
  detectedHookInstallers,
  findHookInstaller,
  hookInstallers,
  validateHookInstallers
} = require('../dist/hook-installers');
const { toolProviders } = require('../dist/providers/registry');
const { createTestEnvironment, runCli } = require('./helpers');

const REMOVED_COMMANDS = [
  'setup-codex-hooks',
  'install-codex-hooks',
  'uninstall-codex-hooks',
  'codex-hooks-status',
  'setup-claude-hooks',
  'install-claude-hooks',
  'enable-claude-hooks',
  'disable-claude-hooks',
  'uninstall-claude-hooks',
  'claude-hooks-status',
  'setup-grok-hooks',
  'install-grok-hooks',
  'enable-grok-hooks',
  'disable-grok-hooks',
  'uninstall-grok-hooks',
  'grok-hooks-status'
];

function createHarnessEnvironment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-command-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const codexHome = path.join(root, 'codex');
  const grokHooksDir = path.join(root, 'grok');
  const claudeConfigDir = path.join(root, 'claude');
  // `hooks setup` copies a runtime into the install directory and restarts the
  // managed daemon, both of which hang off the home directory. Without this the
  // suite would overwrite the developer's own install and bounce their daemon.
  const { env } = createTestEnvironment(t, {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: codexHome,
    DISCORD_CODING_STATUS_GROK_HOOKS_DIR: grokHooksDir,
    CLAUDE_CONFIG_DIR: claudeConfigDir
  });

  return {
    env,
    codexHooksFile: path.join(codexHome, 'hooks.json'),
    grokHooksFile: path.join(grokHooksDir, 'discord-coding-status.json'),
    claudeSettingsFile: path.join(claudeConfigDir, 'settings.json')
  };
}

test('every hook installer is backed by a provider that declares the capability', () => {
  validateHookInstallers(hookInstallers, toolProviders);

  for (const installer of hookInstallers) {
    const owners = toolProviders.filter((provider) => provider.hooks?.includes(installer.capability));
    assert.ok(owners.length > 0, `${installer.capability} has no declaring provider`);
    assert.ok(installer.events.length > 0, `${installer.capability} declares no events`);
    assert.equal(typeof installer.install, 'function');
    assert.equal(typeof installer.uninstall, 'function');
    assert.equal(typeof installer.status, 'function');
  }
});

test('validation rejects an installer no provider declares', () => {
  const orphan = {
    capability: 'nosuchharness',
    label: 'No Such Harness',
    events: ['SessionStart'],
    install: () => ({ target: '', installed: 0, removed: 0 }),
    uninstall: () => ({ target: '', removed: 0 }),
    status: () => ({
      target: '',
      targetExists: false,
      installed: false,
      managedCount: 0,
      expectedEvents: [],
      missingEvents: [],
      duplicateEvents: [],
      unexpectedEvents: []
    })
  };

  assert.throws(
    () => validateHookInstallers([orphan], toolProviders),
    /no provider declaring it: nosuchharness/
  );
});

test('harnesses resolve by capability, label, provider id, and family', () => {
  assert.equal(findHookInstaller('codex')?.capability, 'codex');
  assert.equal(findHookInstaller('CODEX')?.capability, 'codex');
  assert.equal(findHookInstaller('Grok Code')?.capability, 'grok');
  assert.equal(findHookInstaller('claudeCode')?.capability, 'claude');
  assert.equal(findHookInstaller('claude')?.capability, 'claude');
  assert.equal(findHookInstaller('nope'), null);
  assert.equal(findHookInstaller(''), null);
});

test('detected installers follow provider detection rather than a hardcoded list', () => {
  const detections = [
    { key: 'codexCli', detected: true },
    { key: 'claudeCode', detected: false }
  ];

  const detected = detectedHookInstallers(detections, hookInstallers, toolProviders);
  assert.deepEqual(detected.map((installer) => installer.capability), ['codex']);
  assert.deepEqual(detectedHookInstallers([], hookInstallers, toolProviders), []);
});

test('positional parsing agrees with flag parsing about consumed tokens', () => {
  assert.deepEqual(parsePositionals(['setup', 'codex', 'grok']), ['setup', 'codex', 'grok']);
  assert.deepEqual(parsePositionals(['status']), ['status']);
  assert.deepEqual(parsePositionals([]), []);
  // `--event Stop` consumes Stop as the flag value, so it is not a positional.
  assert.deepEqual(parsePositionals(['setup', '--event', 'Stop', 'codex']), ['setup', 'codex']);
  assert.deepEqual(parsePositionals(['setup', '--json=1', 'codex']), ['setup', 'codex']);
});

function fakeInstaller(capability) {
  return {
    capability,
    label: capability,
    events: ['SessionStart'],
    install: () => ({ target: `/tmp/${capability}`, installed: 1, removed: 0 }),
    uninstall: () => ({ target: `/tmp/${capability}`, removed: 1 }),
    status: () => ({
      target: `/tmp/${capability}`,
      targetExists: true,
      installed: true,
      managedCount: 1,
      expectedEvents: ['SessionStart'],
      missingEvents: [],
      duplicateEvents: [],
      unexpectedEvents: []
    })
  };
}

function spyContext(overrides = {}) {
  const calls = { runtime: 0, restart: 0 };
  const installer = fakeInstaller('codex');
  const context = {
    appTitle: 'Discord Coding Status',
    installers: [installer],
    detectedInstallers: () => [installer],
    findInstaller: (name) => (name === 'codex' ? installer : null),
    getRuntimeScriptPath: () => { calls.runtime += 1; return '/tmp/app/dist/cli.js'; },
    restartDaemon: () => { calls.restart += 1; return { status: 'restarted' }; },
    ...overrides
  };
  return { context, calls };
}

test('hooks setup restarts the daemon that copying the runtime stopped', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { context, calls } = spyContext();

  assert.equal(runHooksCommand('hooks', ['setup', 'codex'], context), true);
  assert.equal(calls.runtime, 1, 'the runtime copy ran');
  assert.equal(calls.restart, 1, 'and the daemon was brought back up');

  const output = log.mock.calls.map((call) => String(call.arguments[0])).join('\n');
  assert.match(output, /Daemon restarted/);
});

test('hooks uninstall and status leave the daemon alone', (t) => {
  t.mock.method(console, 'log', () => {});

  for (const action of ['uninstall', 'status']) {
    const { context, calls } = spyContext();
    assert.equal(runHooksCommand('hooks', [action, 'codex'], context), true);
    assert.equal(calls.runtime, 0, `${action} must not copy the runtime`);
    assert.equal(calls.restart, 0, `${action} must not restart the daemon`);
  }
});

test('a daemon that is not installed is reported, not treated as a failure', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { context } = spyContext({ restartDaemon: () => ({ status: 'not-installed' }) });

  assert.equal(runHooksCommand('hooks', ['setup', 'codex'], context), true);
  const output = log.mock.calls.map((call) => String(call.arguments[0])).join('\n');
  assert.match(output, /No managed daemon is installed/);
  assert.doesNotMatch(output, /could not be restarted/);
});

test('hooks setup installs only the named harnesses', async (t) => {
  const { env, codexHooksFile, grokHooksFile, claudeSettingsFile } = createHarnessEnvironment(t);

  await runCli(['hooks', 'setup', 'codex', 'grok'], env);

  assert.ok(fs.existsSync(codexHooksFile), 'codex hooks written');
  assert.ok(fs.existsSync(grokHooksFile), 'grok hooks written');
  assert.equal(fs.existsSync(claudeSettingsFile), false, 'claude was not named, so it stays untouched');

  const status = JSON.parse((await runCli(['hooks', 'status'], env)).stdout).harnesses;
  assert.equal(status.codex.installed, true);
  assert.equal(status.grok.installed, true);
  assert.equal(status.claude.installed, false);
  assert.equal(status.claude.managedCount, 0);
});

test('hooks uninstall removes only the named harness', async (t) => {
  const { env } = createHarnessEnvironment(t);

  await runCli(['hooks', 'setup', 'codex', 'grok'], env);
  await runCli(['hooks', 'uninstall', 'grok'], env);

  const status = JSON.parse((await runCli(['hooks', 'status'], env)).stdout).harnesses;
  assert.equal(status.codex.installed, true);
  assert.equal(status.grok.managedCount, 0);
});

test('hooks reports unknown actions and harnesses without writing anything', async (t) => {
  const { env, codexHooksFile } = createHarnessEnvironment(t);

  await assert.rejects(
    () => runCli(['hooks', 'frobnicate'], env),
    /Unknown hooks action: frobnicate/
  );
  await assert.rejects(
    () => runCli(['hooks', 'setup', 'nope'], env),
    /Unknown harness: nope/
  );

  assert.equal(fs.existsSync(codexHooksFile), false, 'a rejected command writes nothing');
});

test('bare `hooks` prints usage and succeeds', async (t) => {
  const { env } = createHarnessEnvironment(t);

  const result = await runCli(['hooks'], env);
  assert.match(result.stdout, /hooks <setup\|uninstall\|status> \[harness\.\.\.\]/);
  for (const installer of hookInstallers) {
    assert.ok(result.stdout.includes(installer.capability), `usage lists ${installer.capability}`);
  }
});

test('the per-harness hook commands are gone', async (t) => {
  const { env } = createHarnessEnvironment(t);

  for (const command of REMOVED_COMMANDS) {
    await assert.rejects(
      () => runCli([command], env),
      new RegExp(`Unknown command: ${command}`),
      `${command} should no longer be routed`
    );
  }
});
