'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isClaudeCodeProcess,
  isClaudeCodeUrlHandlerProcess,
  isClaudeDesktopProcess,
  isCodexCliProcess,
  isCodexDesktopProcess,
  parseWindowsStartApps,
  windowsDesktopAppDetail
} = require('../dist/core/detection/tool-detection');

test('Windows Start Apps identify official desktop surface names without fixed install paths', () => {
  const apps = parseWindowsStartApps(JSON.stringify([
    { Name: 'ChatGPT', AppID: 'OpenAI.ChatGPT_abc!App' },
    { Name: 'Claude', AppID: 'Anthropic.Claude_xyz!App' },
    { Name: 'ChatGPT Helper', AppID: 'Example.Helper_123!App' }
  ]));

  assert.deepEqual(apps[0], {
    name: 'ChatGPT',
    appId: 'OpenAI.ChatGPT_abc!App'
  });
  assert.equal(
    windowsDesktopAppDetail(apps[0]),
    'shell:AppsFolder\\OpenAI.ChatGPT_abc!App'
  );
  assert.equal(windowsDesktopAppDetail(null), null);
  assert.deepEqual(parseWindowsStartApps('{invalid'), []);
});

test('Codex desktop processes are not misclassified as Codex CLI', () => {
  const macHost = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const macAppServer = '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server';
  const windowsHost = {
    line: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0_x64\\ChatGPT.exe',
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0_x64\\ChatGPT.exe'
  };
  const windowsAppServer = {
    line: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0_x64\\resources\\codex.exe app-server',
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0_x64\\resources\\codex.exe',
    commandLine: 'codex.exe app-server'
  };
  const cli = {
    line: '/opt/homebrew/bin/codex app-server',
    executablePath: '/opt/homebrew/bin/codex',
    commandLine: 'codex app-server'
  };

  for (const process of [macHost, macAppServer, windowsHost, windowsAppServer]) {
    assert.equal(isCodexDesktopProcess(process), true);
    assert.equal(isCodexCliProcess(process), false);
  }
  assert.equal(isCodexDesktopProcess(cli), false);
  assert.equal(isCodexCliProcess(cli), true);
});

test('Claude Desktop, Claude Code, and the URL handler remain separate', () => {
  const macDesktop = '/Applications/Claude.app/Contents/MacOS/Claude';
  const windowsDesktop = {
    line: 'C:\\Program Files\\WindowsApps\\Anthropic.Claude_1.0_x64\\Claude.exe',
    executablePath: 'C:\\Program Files\\WindowsApps\\Anthropic.Claude_1.0_x64\\Claude.exe'
  };
  const windowsLocalDesktop = {
    line: 'C:\\Users\\example\\AppData\\Local\\AnthropicClaude\\Claude.exe',
    executablePath: 'C:\\Users\\example\\AppData\\Local\\AnthropicClaude\\Claude.exe'
  };
  const code = {
    line: '/opt/homebrew/bin/claude',
    executablePath: '/opt/homebrew/bin/claude',
    commandLine: 'claude'
  };
  const urlHandler = '/Users/example/Applications/Claude Code URL Handler.app/Contents/MacOS/claude';
  const windowsUrlHandler = 'C:\\Users\\example\\AppData\\Local\\Claude Code URL Handler\\Claude.exe';

  for (const process of [macDesktop, windowsDesktop, windowsLocalDesktop]) {
    assert.equal(isClaudeDesktopProcess(process), true);
    assert.equal(isClaudeCodeProcess(process), false);
  }
  assert.equal(isClaudeDesktopProcess(code), false);
  assert.equal(isClaudeCodeProcess(code), true);
  assert.equal(isClaudeCodeUrlHandlerProcess(urlHandler), true);
  assert.equal(isClaudeCodeUrlHandlerProcess(windowsUrlHandler), true);
  assert.equal(isClaudeDesktopProcess(urlHandler), false);
  assert.equal(isClaudeCodeProcess(urlHandler), false);
  assert.equal(isClaudeDesktopProcess(windowsUrlHandler), false);
  assert.equal(isClaudeCodeProcess(windowsUrlHandler), false);
});

test('package-manager wrappers remain valid CLI processes', () => {
  const claudeWrapper = 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
  const codexWrapper = 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js';

  assert.equal(isClaudeCodeProcess(claudeWrapper), true);
  assert.equal(isClaudeDesktopProcess(claudeWrapper), false);
  assert.equal(isCodexCliProcess(codexWrapper), true);
  assert.equal(isCodexDesktopProcess(codexWrapper), false);
});
