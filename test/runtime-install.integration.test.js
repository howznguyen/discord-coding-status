'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveRuntimeInstallCommand } = require('../dist/core/runtime/install-command');

const NODE = '/usr/local/bin/node';
const INSTALL_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'];

function resolve(overrides = {}) {
  return resolveRuntimeInstallCommand({
    packageManagerPathExists: true,
    platform: 'darwin',
    runtimePath: NODE,
    ...overrides
  });
}

test('package managers exposing a JavaScript entry are run through the runtime', () => {
  // npm, yarn, and pnpm all point npm_execpath at a script, not an executable.
  const entries = [
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/yarn/bin/yarn.js',
    '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs',
    '/opt/pm/cli.mjs'
  ];

  for (const packageManagerPath of entries) {
    assert.deepEqual(
      resolve({ packageManagerPath }),
      { command: NODE, args: [packageManagerPath, ...INSTALL_ARGS] },
      packageManagerPath
    );
  }
});

test('bun is executed directly instead of being parsed as JavaScript', () => {
  // The reported bug: bun points npm_execpath at its own native binary, and
  // `node /path/to/bun install` made Node read the binary as a script and die
  // with "SyntaxError: Invalid or unexpected token".
  const bun = '/Users/example/.bun/bin/bun';

  assert.deepEqual(
    resolve({ packageManagerPath: bun }),
    { command: bun, args: INSTALL_ARGS }
  );
});

test('bun.exe on Windows is executed directly as well', () => {
  const bun = 'C:\\Users\\example\\.bun\\bin\\bun.exe';

  assert.deepEqual(
    resolve({ packageManagerPath: bun, platform: 'win32', comSpec: 'C:\\Windows\\cmd.exe' }),
    { command: bun, args: INSTALL_ARGS }
  );
});

test('Windows shim scripts go through the command interpreter', () => {
  // `.cmd` and `.bat` are scripts the process loader cannot execute directly.
  for (const shim of ['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\tools\\pnpm.bat']) {
    assert.deepEqual(
      resolve({ packageManagerPath: shim, platform: 'win32', comSpec: 'C:\\Windows\\cmd.exe' }),
      { command: 'C:\\Windows\\cmd.exe', args: ['/d', '/s', '/c', shim, ...INSTALL_ARGS] },
      shim
    );
  }
});

test('a missing or absent package manager path falls back to npm', () => {
  const absent = [
    { packageManagerPath: undefined, packageManagerPathExists: false },
    { packageManagerPath: null, packageManagerPathExists: false },
    { packageManagerPath: '', packageManagerPathExists: false },
    // Recorded in the environment but no longer on disk.
    { packageManagerPath: '/gone/npm-cli.js', packageManagerPathExists: false }
  ];

  for (const options of absent) {
    assert.deepEqual(resolve(options), { command: 'npm', args: INSTALL_ARGS });
    assert.deepEqual(
      resolve({ ...options, platform: 'win32', comSpec: 'C:\\Windows\\cmd.exe' }),
      { command: 'C:\\Windows\\cmd.exe', args: ['/d', '/s', '/c', 'npm', ...INSTALL_ARGS] }
    );
  }
});

test('Windows falls back to cmd.exe when ComSpec is unset', () => {
  assert.deepEqual(
    resolve({ packageManagerPathExists: false, platform: 'win32', comSpec: undefined }),
    { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...INSTALL_ARGS] }
  );
});

test('the caller cannot mutate the shared argument list', () => {
  const first = resolve({ packageManagerPath: '/x/npm-cli.js' });
  first.args.push('--tampered');

  const second = resolve({ packageManagerPath: '/x/npm-cli.js' });
  assert.deepEqual(second.args, ['/x/npm-cli.js', ...INSTALL_ARGS]);
});
