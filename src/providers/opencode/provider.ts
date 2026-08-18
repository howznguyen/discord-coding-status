'use strict';

import type { ProcessInfo } from '../../core/tools/types';
import type { ToolProvider } from '../../core/providers/types';
import { isOpencodeProcess } from '../../core/detection/tool-detection';

export const DEFAULT_OPENCODE_CLIENT_ID = '1538957549364322404';

export const opencodeCliProvider: ToolProvider = {
  id: 'opencodeCli',
  family: 'opencode',
  presence: {
    key: 'opencodeCli',
    details: 'Using OpenCode',
    state: 'OpenCode CLI',
    family: 'opencode'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 30,
    matches: isOpencodeProcess
  },
  setup: {
    name: 'OpenCode',
    order: 60,
    probe: {
      kind: 'executable',
      candidates: ['opencode']
    }
  },
  discord: {
    application: 'opencode',
    label: 'OpenCode',
    defaultClientId: DEFAULT_OPENCODE_CLIENT_ID
  }
};

export const opencodeConfigProvider: ToolProvider = {
  id: 'opencodeHome',
  family: 'opencode',
  setup: {
    name: 'OpenCode config',
    order: 61,
    probe: {
      kind: 'path',
      defaultPath: '~/.config/opencode'
    }
  }
};

export const opencodeProviders: readonly ToolProvider[] = [
  opencodeCliProvider,
  opencodeConfigProvider
];