'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectActiveTools } = require('../dist/core/detection/active-tools');
const { toolProviders } = require('../dist/providers/registry');
const {
  detectedClaudeForSetup,
  shouldInstallClaudeHooks
} = require('../dist/commands/setup/policy');

function processInfo(pid, line, executablePath = null) {
  return {
    pid,
    line,
    raw: line,
    executablePath,
    commandLine: line
  };
}

test('active-tool orchestration prefers desktop Codex unless CLI preference is enabled', () => {
  const processes = [
    processInfo(1, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
    processInfo(2, '/opt/homebrew/bin/codex', '/opt/homebrew/bin/codex'),
    processInfo(3, '/Applications/Claude.app/Contents/MacOS/Claude'),
    processInfo(4, '/opt/homebrew/bin/claude', '/opt/homebrew/bin/claude')
  ];

  assert.deepEqual(
    detectActiveTools(processes, toolProviders).map((tool) => tool.key),
    ['claude', 'codexApp']
  );
  assert.deepEqual(
    detectActiveTools(processes, toolProviders, {
      preferredSurfaceByFamily: { codex: 'cli' }
    }).map((tool) => tool.key),
    ['claude', 'codexCli']
  );
});

test('Claude Desktop alone does not enable Claude Code lifecycle hooks', () => {
  const detections = [
    {
      key: 'claudeApp',
      name: 'Claude App',
      detected: true,
      detail: '/Applications/Claude.app'
    }
  ];

  assert.equal(detectedClaudeForSetup(detections, toolProviders), false);
  assert.equal(shouldInstallClaudeHooks({}, detections, toolProviders), false);
  assert.equal(shouldInstallClaudeHooks(
    { 'claude-hooks': true },
    detections,
    toolProviders
  ), true);
});

test('Claude Code URL handler is ignored as an active tool', () => {
  const urlHandler = processInfo(
    1,
    '/Users/example/Applications/Claude Code URL Handler.app/Contents/MacOS/claude'
  );

  assert.deepEqual(detectActiveTools([urlHandler], toolProviders), []);
});
