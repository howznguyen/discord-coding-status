'use strict';

import type { ToolProvider } from '../../core/providers/types';
import { isPiProcess } from '../../core/detection/tool-detection';

export const DEFAULT_PI_CLIENT_ID = '1538957711503396986';

export const piCliProvider: ToolProvider = {
  id: 'piCli',
  family: 'pi',
  presence: {
    key: 'piCli',
    details: 'Using Pi',
    state: 'Pi coding agent',
    family: 'pi'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 40,
    matches: isPiProcess
  },
  setup: {
    name: 'Pi',
    order: 70,
    probe: {
      kind: 'executable',
      candidates: ['pi']
    }
  },
  discord: {
    application: 'pi',
    label: 'Pi',
    defaultClientId: DEFAULT_PI_CLIENT_ID
  }
};

export const piConfigProvider: ToolProvider = {
  id: 'piHome',
  family: 'pi',
  setup: {
    name: 'Pi config',
    order: 71,
    probe: {
      kind: 'path',
      defaultPath: '~/.pi/agent'
    }
  }
};

export const piProviders: readonly ToolProvider[] = [
  piCliProvider,
  piConfigProvider
];