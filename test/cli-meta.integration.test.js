'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createTestEnvironment,
  runCli
} = require('./helpers');

test('an empty CLI invocation prints project information and usage without starting the daemon', async (t) => {
  const { env } = createTestEnvironment(t);
  const result = await runCli([], env);

  assert.match(result.stdout, /Discord Coding Status \d+\.\d+\.\d+/);
  assert.match(result.stdout, /Local Discord Rich Presence for Codex and Claude Code\./);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /Author: @howznguyen/);
  assert.match(result.stdout, /Website: https:\/\/howznguyen\.dev\/projects\/discord-coding-status/);
  assert.match(result.stdout, /Repository: https:\/\/github\.com\/howznguyen\/discord-coding-status/);
  assert.match(result.stdout, /npx -y discord-coding-status@latest setup/);
  assert.doesNotMatch(result.stdout, /Starting Discord Coding Status daemon/);
  assert.equal(result.stderr, '');
});
