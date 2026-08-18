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

test('processes that stopped consuming CPU stop being reported as active sessions', async () => {
  const idlePi = {
    pid: 91001,
    line: '/opt/homebrew/bin/pi',
    raw: '/opt/homebrew/bin/pi pi',
    executablePath: '/opt/homebrew/bin/pi',
    commandLine: 'pi',
    cpuMs: 1200
  };
  const options = { idleGraceMs: 0 };

  // First observation: a live process with CPU data counts as a session.
  assert.deepEqual(detectActiveTools([idlePi], toolProviders, options).map((tool) => tool.key), ['piCli']);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Second observation with no CPU growth: the process is alive but idle, so
  // it must not keep reporting as an active Pi session.
  assert.deepEqual(detectActiveTools([idlePi], toolProviders, options), []);
});

test('processes that keep consuming CPU remain active across polls', () => {
  const busyPi = {
    pid: 91002,
    line: '/opt/homebrew/bin/pi',
    raw: '/opt/homebrew/bin/pi pi',
    executablePath: '/opt/homebrew/bin/pi',
    commandLine: 'pi',
    cpuMs: 500
  };
  const options = { idleGraceMs: 0 };

  assert.deepEqual(detectActiveTools([busyPi], toolProviders, options).map((tool) => tool.key), ['piCli']);
  busyPi.cpuMs = 900; // consumed 400ms since the previous poll
  assert.deepEqual(detectActiveTools([busyPi], toolProviders, options).map((tool) => tool.key), ['piCli']);
});

test('multiple alive processes drop stale ones and keep the active session', async () => {
  const staleKnownsSession = {
    pid: 91003,
    line: '/opt/homebrew/bin/pi',
    raw: '/opt/homebrew/bin/pi pi',
    executablePath: '/opt/homebrew/bin/pi',
    commandLine: 'pi',
    cpuMs: 2000
  };
  const activeSession = {
    pid: 91004,
    line: '/opt/homebrew/bin/pi',
    raw: '/opt/homebrew/bin/pi pi',
    executablePath: '/opt/homebrew/bin/pi',
    commandLine: 'pi',
    cpuMs: 300
  };
  const options = { idleGraceMs: 0 };

  assert.deepEqual(detectActiveTools([staleKnownsSession, activeSession], toolProviders, options)
    .map((tool) => tool.key), ['piCli']);
  await new Promise((resolve) => setTimeout(resolve, 10));
  activeSession.cpuMs = 700; // the active session is still doing work
  const [tool] = detectActiveTools([staleKnownsSession, activeSession], toolProviders, options);
  // The stale Knowns session stopped consuming CPU; the active one survives.
  assert.equal(tool.processInfo.pid, 91004);
});
