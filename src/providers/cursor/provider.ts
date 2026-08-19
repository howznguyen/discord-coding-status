'use strict';

import type { ProcessInfo, ToolDefinition, ToolFamily } from '../../core/tools/types';
import type { ToolProvider } from '../../core/providers/types';
import { isCursorProcess } from '../../core/detection/tool-detection';

export const DEFAULT_CURSOR_CLIENT_ID = '1539572948904575087';

export const cursorDesktopProvider: ToolProvider = {
  id: 'cursorApp',
  family: 'cursor',
  presence: {
    key: 'cursorApp',
    details: 'Using Cursor',
    state: 'Cursor IDE',
    family: 'cursor'
  },
  process: {
    surface: 'desktop',
    priority: 30,
    familyOrder: 60,
    matches: isCursorProcess
  },
  setup: {
    name: 'Cursor IDE',
    order: 90,
    probe: {
      kind: 'desktop',
      macCandidates: [
        { bundleName: 'Cursor.app', bundleIdentifier: 'com.anysphere.cursor' },
        { bundleName: 'Cursor.app', bundleIdentifier: 'com.todesktop.230313mzl4w4u92' }
      ],
      windowsStartNames: ['Cursor']
    }
  },
  discord: {
    application: 'cursor',
    label: 'Cursor',
    defaultClientId: DEFAULT_CURSOR_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_CURSOR_CLIENT_ID',
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_CURSOR_IMAGE_KEY'
  }
};

export const cursorCliProvider: ToolProvider = {
  id: 'cursorCli',
  family: 'cursor',
  presence: {
    key: 'cursorCli',
    details: 'Using Cursor',
    state: 'Cursor CLI',
    family: 'cursor'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 60,
    matches: isCursorProcess
  },
  setup: {
    name: 'Cursor CLI',
    order: 91,
    probe: {
      kind: 'executable',
      candidates: ['cursor']
    }
  },
  discord: {
    application: 'cursor',
    label: 'Cursor',
    defaultClientId: DEFAULT_CURSOR_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_CURSOR_CLIENT_ID',
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_CURSOR_IMAGE_KEY'
  }
};

export const cursorConfigProvider: ToolProvider = {
  id: 'cursorHome',
  family: 'cursor',
  setup: {
    name: 'Cursor config',
    order: 92,
    probe: {
      kind: 'path',
      defaultPath: '~/.cursor'
    }
  }
};

export const cursorProviders: readonly ToolProvider[] = [
  cursorDesktopProvider,
  cursorCliProvider,
  cursorConfigProvider
];
