'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { powershellCommandLine, powershellQuoteArg } = require('../dist/env');
const { createTestEnvironment, runCli } = require('./helpers');

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
];

function createCodexEnvironment(t) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-test-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  const { env } = createTestEnvironment(t, { CODEX_HOME: codexHome });
  return { codexHome, env, hooksFile: path.join(codexHome, 'hooks.json') };
}

function readHooks(hooksFile) {
  return JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks;
}

function managedHooksFor(hooks, eventName) {
  return (hooks[eventName] || [])
    .flatMap((group) => (Array.isArray(group.hooks) ? group.hooks : []))
    .filter((hook) => hook.statusMessage === 'Discord Coding Status');
}

test('codex hook install writes matcher groups Codex can deserialize', async (t) => {
  const { env, hooksFile } = createCodexEnvironment(t);

  await runCli(['hooks', 'setup', 'codex'], env);

  const hooks = readHooks(hooksFile);
  assert.deepEqual(Object.keys(hooks).sort(), [...CODEX_HOOK_EVENTS].sort());

  for (const eventName of CODEX_HOOK_EVENTS) {
    const groups = hooks[eventName];
    // Codex parses `hooks[event]` as a list of matcher groups; a flat handler
    // object deserializes into an empty group and silently disables the hook.
    assert.ok(Array.isArray(groups) && groups.length === 1, `expected one group for ${eventName}`);
    assert.ok(Array.isArray(groups[0].hooks), `expected a nested hooks list for ${eventName}`);

    const hook = groups[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.statusMessage, 'Discord Coding Status');
    assert.match(hook.command, /codex-hook/);
    assert.ok(hook.command.includes(eventName), `command references ${eventName}`);
  }
});

test('codex hooks carry a PowerShell-parseable commandWindows variant', async (t) => {
  const { env, hooksFile } = createCodexEnvironment(t);

  await runCli(['hooks', 'setup', 'codex'], env);

  for (const eventName of CODEX_HOOK_EVENTS) {
    const [hook] = managedHooksFor(readHooks(hooksFile), eventName);
    // Windows runs hooks through `powershell.exe -NoProfile -Command`, which
    // reports a ParserError unless the quoted executable is invoked through `&`.
    assert.ok(
      hook.commandWindows.startsWith("& '"),
      `commandWindows for ${eventName} must start with the PowerShell call operator`
    );
    assert.ok(hook.commandWindows.includes('codex-hook'));
    assert.ok(hook.commandWindows.includes(eventName));
    assert.equal(hook.commandWindows.includes('\\"'), false, 'no cmd.exe-style escapes');
  }
});

test('powershell quoting keeps literal paths intact', () => {
  assert.equal(powershellQuoteArg("C:\\Users\\o'brien\\node.exe"), "'C:\\Users\\o''brien\\node.exe'");
  assert.equal(powershellQuoteArg('C:\\Users\\$env\\node.exe'), "'C:\\Users\\$env\\node.exe'");
  assert.equal(powershellCommandLine(['C:\\node.exe', 'a b']), "& 'C:\\node.exe' 'a b'");
});

test('reinstalling codex hooks replaces the managed group instead of stacking duplicates', async (t) => {
  const { env, hooksFile } = createCodexEnvironment(t);

  await runCli(['hooks', 'setup', 'codex'], env);
  await runCli(['hooks', 'setup', 'codex'], env);

  const hooks = readHooks(hooksFile);
  for (const eventName of CODEX_HOOK_EVENTS) {
    assert.equal(managedHooksFor(hooks, eventName).length, 1, `one managed hook for ${eventName}`);
  }

  const status = JSON.parse((await runCli(['hooks', 'status', 'codex'], env)).stdout).harnesses.codex;
  assert.equal(status.installed, true);
  assert.equal(status.managedCount, CODEX_HOOK_EVENTS.length);
  assert.deepEqual(status.missingEvents, []);
});

test('uninstalling codex hooks leaves third-party hooks untouched', async (t) => {
  const { env, hooksFile } = createCodexEnvironment(t);

  await runCli(['hooks', 'setup', 'codex'], env);

  const config = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const foreignGroup = {
    matcher: '*',
    hooks: [{ type: 'command', command: '/usr/bin/true', statusMessage: 'Third party' }]
  };
  config.hooks.PostToolUse.unshift(foreignGroup);
  fs.writeFileSync(hooksFile, `${JSON.stringify(config, null, 2)}\n`);

  await runCli(['hooks', 'uninstall', 'codex'], env);

  const hooks = readHooks(hooksFile);
  assert.deepEqual(Object.keys(hooks), ['PostToolUse']);
  assert.deepEqual(hooks.PostToolUse, [foreignGroup]);
});
