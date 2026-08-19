'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MENU_ITEMS, renderMenu } = require('../dist/commands/menu/tui');
const { runMenuCommand, shouldOpenMenu } = require('../dist/commands/menu/command');
const { createTestEnvironment, runCli } = require('./helpers');

const HEADER = { appTitle: 'Discord Coding Status', version: '1.0.0', subtitle: 'Subtitle' };

function context(overrides = {}) {
  return {
    appTitle: HEADER.appTitle,
    version: HEADER.version,
    subtitle: HEADER.subtitle,
    isInteractive: () => true,
    run: async () => ({ code: 0 }),
    ...overrides
  };
}

test('only a bare invocation on a real terminal opens the menu', () => {
  assert.equal(shouldOpenMenu('', context()), true);
  assert.equal(shouldOpenMenu('  ', context()), true);

  // Everything else keeps the previous behaviour.
  assert.equal(shouldOpenMenu('', context({ isInteractive: () => false })), false);
  for (const command of ['--help', '-h', 'help', 'setup', 'hooks', 'daemon', 'status']) {
    assert.equal(shouldOpenMenu(command, context()), false, `${command} must not open the menu`);
  }
});

test('runMenuCommand declines every invocation it does not own', async () => {
  let ran = false;
  const spy = context({ run: async () => { ran = true; return { code: 0 }; } });

  assert.equal(await runMenuCommand('--help', spy), false);
  assert.equal(await runMenuCommand('setup', spy), false);
  assert.equal(await runMenuCommand('', context({ isInteractive: () => false })), false);
  assert.equal(ran, false, 'declining must not execute anything');
});

test('menu items are well formed and route to real commands', () => {
  const ids = new Set();
  const runnable = MENU_ITEMS.filter((item) => item.argv);

  for (const item of MENU_ITEMS) {
    assert.ok(item.id && !ids.has(item.id), `duplicate or empty id: ${item.id}`);
    ids.add(item.id);
    assert.ok(item.label.trim(), `${item.id} needs a label`);
    assert.ok(item.hint.trim(), `${item.id} needs a hint`);
    assert.ok(item.section.trim(), `${item.id} needs a section`);
  }

  assert.ok(ids.has('quit'), 'the menu must offer a way out');
  assert.equal(MENU_ITEMS.find((item) => item.id === 'quit').argv, undefined);

  // Guards against drift from the `hooks setup|uninstall|status` refactor.
  const argvById = Object.fromEntries(runnable.map((item) => [item.id, item.argv.join(' ')]));
  assert.equal(argvById['hooks-setup'], 'hooks setup');
  assert.equal(argvById['hooks-status'], 'hooks status');
  assert.equal(argvById['hooks-uninstall'], 'hooks uninstall');
  assert.equal(argvById.setup, 'setup');
  assert.equal(argvById.config, 'config');
  assert.equal(argvById.status, 'status');
  assert.equal(argvById.daemon, 'daemon');
  assert.equal(argvById.help, '--help');

  // Only long-running commands may hand the terminal over.
  for (const item of MENU_ITEMS) {
    if (item.takesOver) {
      assert.equal(item.id, 'daemon', `${item.id} should return to the menu`);
    }
  }
});

test('rendering marks the selected row and lists every item', () => {
  const frame = renderMenu(MENU_ITEMS, 2, HEADER);

  for (const item of MENU_ITEMS) {
    assert.ok(frame.includes(item.label), `frame is missing ${item.label}`);
  }
  assert.ok(frame.includes(HEADER.appTitle));
  assert.ok(frame.includes('↑/↓ move'));

  const rows = frame.split('\n').filter((line) => line.includes('›'));
  assert.equal(rows.length, 1, 'exactly one row is selected');
  assert.ok(rows[0].includes(MENU_ITEMS[2].label), 'the pointer sits on the selected item');
});

test('a bare non-interactive invocation still prints the same help as --help', async (t) => {
  const { env } = createTestEnvironment(t);

  // runCli spawns with pipes, so neither stdin nor stdout is a TTY — the exact
  // shape of a CI run, a pipe, or a script.
  const bare = await runCli([], env);
  const help = await runCli(['--help'], env);

  assert.equal(bare.stdout, help.stdout);
  assert.equal(bare.stderr, '');
  assert.match(bare.stdout, /Usage:/);
  assert.doesNotMatch(bare.stdout, /↑\/↓ move/, 'the menu must not render without a TTY');
});
