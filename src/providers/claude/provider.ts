'use strict';

import type { ToolProvider } from '../../core/providers/types';
import {
  isClaudeCodeProcess,
  isClaudeDesktopProcess
} from '../../core/detection/tool-detection';

export const DEFAULT_CLAUDE_CLIENT_ID = '1521213655092428923';

export const claudeCodeProvider: ToolProvider = {
  id: 'claudeCode',
  family: 'claude',
  presence: {
    key: 'claude',
    details: 'Using Claude Code',
    state: 'AI coding session',
    family: 'claude'
  },
  process: {
    surface: 'cli',
    priority: 20,
    familyOrder: 10,
    matches: isClaudeCodeProcess
  },
  setup: {
    name: 'Claude Code',
    order: 40,
    probe: {
      kind: 'executable',
      candidates: ['claude', 'claude-code']
    }
  },
  hooks: ['claude'],
  discord: {
    application: 'claude',
    label: 'Claude Code',
    defaultClientId: DEFAULT_CLAUDE_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID',
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_CLAUDE_IMAGE_KEY'
  }
};

export const claudeDesktopProvider: ToolProvider = {
  id: 'claudeApp',
  family: 'claude',
  presence: {
    key: 'claudeApp',
    details: 'Using Claude',
    state: 'Claude App',
    family: 'claude'
  },
  process: {
    surface: 'desktop',
    priority: 10,
    familyOrder: 10,
    matches: isClaudeDesktopProcess
  },
  setup: {
    name: 'Claude App',
    order: 50,
    probe: {
      kind: 'desktop',
      macCandidates: [{ bundleName: 'Claude.app' }],
      windowsStartNames: ['Claude']
    }
  },
  discord: {
    application: 'claude',
    label: 'Claude Code',
    defaultClientId: DEFAULT_CLAUDE_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID',
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_CLAUDE_IMAGE_KEY'
  }
};

export const claudeProviders: readonly ToolProvider[] = [
  claudeCodeProvider,
  claudeDesktopProvider
];
