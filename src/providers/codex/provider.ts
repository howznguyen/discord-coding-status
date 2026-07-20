'use strict';

import type { ProcessInfo } from '../../core/tools/types';
import type { ToolProvider } from '../../core/providers/types';
import {
  isCodexCliProcess,
  isCodexDesktopProcess
} from '../../core/detection/tool-detection';

export const DEFAULT_CODEX_CLIENT_ID = '1517375602662051900';

function isCodexCliProviderProcess(process: ProcessInfo | string): boolean {
  const line = typeof process === 'string' ? process : process.line;
  return !line.toLowerCase().includes('codex computer use.app')
    && isCodexCliProcess(process);
}

export const codexDesktopProvider: ToolProvider = {
  id: 'codexApp',
  family: 'codex',
  presence: {
    key: 'codexApp',
    details: 'Using Codex',
    state: 'Codex App',
    family: 'codex'
  },
  process: {
    surface: 'desktop',
    priority: 20,
    familyOrder: 20,
    matches: isCodexDesktopProcess
  },
  setup: {
    name: 'Codex App',
    order: 20,
    probe: {
      kind: 'desktop',
      macCandidates: [
        {
          bundleName: 'ChatGPT.app',
          bundleIdentifier: 'com.openai.codex',
          requiredRelativePaths: ['Contents/Resources/codex']
        },
        { bundleName: 'Codex.app' }
      ],
      windowsStartNames: ['ChatGPT', 'Codex']
    }
  },
  hooks: ['codex'],
  discord: {
    application: 'codex',
    label: 'Codex',
    defaultClientId: DEFAULT_CODEX_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_CODEX_CLIENT_ID',
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_CODEX_IMAGE_KEY'
  }
};

export const codexCliProvider: ToolProvider = {
  id: 'codexCli',
  family: 'codex',
  presence: {
    key: 'codexCli',
    details: 'Using Codex',
    state: 'Codex CLI',
    family: 'codex'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 20,
    matches: isCodexCliProviderProcess
  },
  setup: {
    name: 'Codex CLI',
    order: 10,
    probe: {
      kind: 'executable',
      candidates: ['codex']
    }
  },
  hooks: ['codex'],
  discord: {
    application: 'codex',
    label: 'Codex',
    defaultClientId: DEFAULT_CODEX_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_CODEX_CLIENT_ID',
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_CODEX_IMAGE_KEY'
  }
};

export const codexConfigProvider: ToolProvider = {
  id: 'codexHome',
  family: 'codex',
  setup: {
    name: 'Codex config',
    order: 30,
    probe: {
      kind: 'path',
      defaultPath: '~/.codex'
    }
  },
  hooks: ['codex']
};

export const codexProviders: readonly ToolProvider[] = [
  codexDesktopProvider,
  codexCliProvider,
  codexConfigProvider
];
