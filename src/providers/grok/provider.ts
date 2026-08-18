'use strict';

import type { ToolProvider } from '../../core/providers/types';
import { isGrokProcess } from '../../core/detection/tool-detection';

// Discord Application ID for Grok Code.
export const DEFAULT_GROK_CLIENT_ID = '1539161996715495445';

export const grokCliProvider: ToolProvider = {
  id: 'grokCli',
  family: 'grok',
  presence: {
    key: 'grokCli',
    details: 'Using Grok',
    state: 'Grok Code',
    family: 'grok'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 50,
    matches: isGrokProcess
  },
  setup: {
    name: 'Grok',
    order: 80,
    probe: {
      kind: 'executable',
      candidates: ['grok']
    }
  },
  discord: {
    application: 'grok',
    label: 'Grok Code',
    defaultClientId: DEFAULT_GROK_CLIENT_ID
  }
};

export const grokConfigProvider: ToolProvider = {
  id: 'grokHome',
  family: 'grok',
  setup: {
    name: 'Grok config',
    order: 81,
    probe: {
      kind: 'path',
      defaultPath: '~/.grok'
    }
  }
};

export const grokProviders: readonly ToolProvider[] = [
  grokCliProvider,
  grokConfigProvider
];