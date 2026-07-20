'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectSetupTools } = require('../dist/adapters/system/installed-tools');
const { detectActiveTools } = require('../dist/core/detection/active-tools');
const {
  detectedHookCapabilityForSetup
} = require('../dist/commands/setup/policy');
const {
  findToolProviderByAlias,
  validateToolProviders
} = require('../dist/providers/registry');
const {
  discordApplicationForTool,
  resolveDiscordApplications
} = require('../dist/providers/discord');
const { codexDesktopProvider } = require('../dist/providers/codex/provider');

const openCodeProvider = {
  id: 'openCode',
  family: 'opencode',
  presence: {
    key: 'openCode',
    details: 'Using OpenCode',
    state: 'OpenCode CLI',
    family: 'opencode'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 30,
    matches: (process) => {
      const line = typeof process === 'string' ? process : process.line;
      return /(?:^|[\\/\s])opencode(?:\.exe)?(?:\s|$)/i.test(line);
    }
  },
  setup: {
    name: 'OpenCode',
    order: 60,
    probe: {
      kind: 'executable',
      candidates: ['opencode']
    }
  },
  hooks: ['opencode'],
  discord: {
    application: 'opencode',
    label: 'OpenCode'
  }
};

const openCodeDesktopProvider = {
  id: 'openCodeApp',
  family: 'opencode',
  presence: {
    key: 'openCodeApp',
    details: 'Using OpenCode',
    state: 'OpenCode App',
    family: 'opencode'
  },
  process: {
    surface: 'desktop',
    priority: 20,
    familyOrder: 30,
    matches: () => false
  },
  setup: {
    name: 'OpenCode App',
    order: 61,
    probe: {
      kind: 'desktop',
      macCandidates: [{ bundleName: 'OpenCode.app' }],
      windowsStartNames: ['OpenCode']
    }
  }
};

function processInfo(pid, line) {
  return { pid, line, raw: line, executablePath: line, commandLine: line };
}

test('a new provider participates in process detection without core changes', () => {
  validateToolProviders([openCodeProvider]);
  const tools = detectActiveTools(
    [processInfo(1, '/usr/local/bin/opencode')],
    [openCodeProvider]
  );

  assert.equal(tools.length, 1);
  assert.equal(tools[0].providerId, 'openCode');
  assert.equal(tools[0].key, 'openCode');
  assert.equal(tools[0].family, 'opencode');
});

test('a new executable provider participates in setup and hook policy through capabilities', () => {
  const detections = detectSetupTools({
    platform: 'linux',
    homeDirectory: '/home/example',
    pathExists: () => false,
    executeFile: (command, args) => {
      if (command === 'which' && args[0] === 'opencode') {
        return '/usr/local/bin/opencode\n';
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  }, [openCodeProvider]);

  assert.deepEqual(detections, [{
    key: 'openCode',
    name: 'OpenCode',
    detected: true,
    detail: '/usr/local/bin/opencode'
  }]);
  assert.equal(
    detectedHookCapabilityForSetup(detections, [openCodeProvider], 'opencode'),
    true
  );
});

test('a new desktop provider uses generic Windows Start Apps discovery', () => {
  const detections = detectSetupTools({
    platform: 'win32',
    homeDirectory: 'C:\\Users\\example',
    pathExists: () => false,
    executeFile: (command) => {
      if (command === 'powershell.exe') {
        return JSON.stringify({ Name: 'OpenCode', AppID: 'OpenCode.Desktop_123!App' });
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  }, [openCodeDesktopProvider]);

  assert.deepEqual(detections, [{
    key: 'openCodeApp',
    name: 'OpenCode App',
    detected: true,
    detail: 'shell:AppsFolder\\OpenCode.Desktop_123!App'
  }]);
});

test('setup path probes use target platform path semantics', () => {
  const provider = {
    id: 'openCodeHome',
    family: 'opencode',
    setup: {
      name: 'OpenCode config',
      order: 62,
      probe: {
        kind: 'path',
        defaultPath: '~/.opencode'
      }
    }
  };
  const expectedPath = 'C:\\Users\\example\\.opencode';
  const detections = detectSetupTools({
    platform: 'win32',
    homeDirectory: 'C:\\Users\\example',
    pathExists: (candidate) => candidate === expectedPath,
    executeFile: (command) => {
      if (command === 'powershell.exe') {
        return '[]';
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  }, [provider]);

  assert.deepEqual(detections, [{
    key: 'openCodeHome',
    name: 'OpenCode config',
    detected: true,
    detail: expectedPath
  }]);
});

test('provider descriptors enforce macOS bundle identity and required runtime paths', () => {
  const existingPaths = new Set([
    '/Applications/ChatGPT.app',
    '/Applications/ChatGPT.app/Contents/Resources/codex'
  ]);
  const detected = detectSetupTools({
    platform: 'darwin',
    homeDirectory: '/Users/example',
    pathExists: (candidate) => existingPaths.has(candidate),
    executeFile: (command) => {
      assert.equal(command, '/usr/bin/plutil');
      return 'com.openai.codex\n';
    }
  }, [codexDesktopProvider]);

  assert.equal(detected[0].detected, true);
  assert.equal(detected[0].detail, '/Applications/ChatGPT.app');

  const rejected = detectSetupTools({
    platform: 'darwin',
    homeDirectory: '/Users/example',
    pathExists: (candidate) => existingPaths.has(candidate),
    executeFile: () => 'com.openai.chatgpt\n'
  }, [codexDesktopProvider]);
  assert.equal(rejected[0].detected, false);
});

test('registry validation rejects ambiguous provider identities', () => {
  assert.throws(
    () => validateToolProviders([openCodeProvider, { ...openCodeProvider }]),
    /Duplicate tool provider id/
  );
});

test('provider Discord metadata resolves without CLI family conditionals', () => {
  const applications = resolveDiscordApplications([openCodeProvider], (name, fallback = '') => {
    if (name === 'DISCORD_CODING_STATUS_OPENCODE_CLIENT_ID') {
      return '123456789012345678';
    }
    if (name === 'DISCORD_CODING_STATUS_OPENCODE_IMAGE_KEY') {
      return 'opencode';
    }
    return fallback;
  });
  const application = discordApplicationForTool(
    {
      providerId: 'openCode',
      key: 'openCode',
      family: 'opencode',
      details: 'Using OpenCode',
      state: 'OpenCode CLI'
    },
    [openCodeProvider],
    applications
  );

  assert.deepEqual(application, {
    key: 'opencode',
    label: 'OpenCode',
    clientId: '123456789012345678',
    clientIdEnvironment: 'DISCORD_CODING_STATUS_OPENCODE_CLIENT_ID',
    imageKey: 'opencode'
  });
  assert.equal(findToolProviderByAlias('open-code', 'cli', [openCodeProvider]).id, 'openCode');
});
