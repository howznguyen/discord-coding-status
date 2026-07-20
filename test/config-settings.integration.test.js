'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  displayLayoutFromEntries,
  normalizeActivityStyle,
  normalizeCodexQuotaSource,
  normalizeDetailLevel,
  parseDotEnv,
  parseJsonConfig
} = require('../dist/commands/config/settings');

test('config parsers normalize JSON aliases and dotenv values', () => {
  assert.deepEqual(parseJsonConfig(JSON.stringify({
    detailLevel: 'full',
    showContext: true,
    preferCodexCli: false
  })), {
    DISCORD_CODING_STATUS_DETAIL_LEVEL: 'full',
    DISCORD_CODING_STATUS_SHOW_CONTEXT: 'true',
    DISCORD_CODING_STATUS_PREFER_CODEX_CLI: 'false'
  });

  assert.deepEqual(parseDotEnv('FOO="bar"\n# ignored\nEMPTY='), {
    FOO: 'bar',
    EMPTY: ''
  });
});

test('config normalization and display defaults stay deterministic', () => {
  assert.equal(normalizeDetailLevel('FULL'), 'full');
  assert.equal(normalizeDetailLevel('invalid'), 'safe');
  assert.equal(normalizeCodexQuotaSource('invalid'), 'oauth');
  assert.equal(normalizeActivityStyle('invalid'), 'fun');
  assert.deepEqual(displayLayoutFromEntries({
    DISCORD_CODING_STATUS_DETAIL_LEVEL: 'full',
    DISCORD_CODING_STATUS_SHOW_CONTEXT: 'true',
    DISCORD_CODING_STATUS_SHOW_PACKAGE: 'false'
  }), {
    activity: true,
    project: true,
    model: true,
    quota: true,
    context: true,
    package: false
  });
});
