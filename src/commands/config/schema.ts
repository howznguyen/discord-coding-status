'use strict';

import type { ActivityStyle, ConfigEditorField, ConfigTuiItem } from './types';

export const DEFAULT_DETAIL_LEVEL = 'project';
export const DEFAULT_CODEX_QUOTA_SOURCE = 'oauth';
export const DEFAULT_CODEX_AUTH_FILE = '~/.codex/auth.json';
export const DEFAULT_CLAUDE_CONFIG_DIR = '~/.claude';
export const DEFAULT_ACTIVITY_STYLE: ActivityStyle = 'fun';

export const JSON_CONFIG_ALIASES: Record<string, string> = {
  codexClientId: 'DISCORD_CODING_STATUS_CODEX_CLIENT_ID',
  claudeClientId: 'DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID',
  clientId: 'DISCORD_CLIENT_ID',
  detailLevel: 'DISCORD_CODING_STATUS_DETAIL_LEVEL',
  quotaSource: 'DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE',
  codexAuthFile: 'DISCORD_CODING_STATUS_CODEX_AUTH_FILE',
  stateFile: 'DISCORD_CODING_STATUS_STATE_FILE',
  claudeImageKey: 'DISCORD_CODING_STATUS_CLAUDE_IMAGE_KEY',
  codexImageKey: 'DISCORD_CODING_STATUS_CODEX_IMAGE_KEY',
  largeImageKey: 'DISCORD_LARGE_IMAGE_KEY',
  smallImageKey: 'DISCORD_SMALL_IMAGE_KEY',
  planText: 'DISCORD_CODING_STATUS_PLAN_TEXT',
  limitsText: 'DISCORD_CODING_STATUS_LIMITS_TEXT',
  preferCodexCli: 'DISCORD_CODING_STATUS_PREFER_CODEX_CLI',
  showActivity: 'DISCORD_CODING_STATUS_SHOW_ACTIVITY',
  showProject: 'DISCORD_CODING_STATUS_SHOW_PROJECT',
  showModel: 'DISCORD_CODING_STATUS_SHOW_MODEL',
  showQuota: 'DISCORD_CODING_STATUS_SHOW_QUOTA',
  showContext: 'DISCORD_CODING_STATUS_SHOW_CONTEXT',
  activityStyle: 'DISCORD_CODING_STATUS_ACTIVITY_STYLE',
  showPackage: 'DISCORD_CODING_STATUS_SHOW_PACKAGE'
};

export const ENV_CONFIG_ALIASES = Object.fromEntries(
  Object.entries(JSON_CONFIG_ALIASES).map(([alias, envName]) => [envName, alias])
) as Record<string, string>;

export const BOOLEAN_CONFIG_KEYS = new Set([
  'DISCORD_CODING_STATUS_PREFER_CODEX_CLI',
  'DISCORD_CODING_STATUS_SHOW_ACTIVITY',
  'DISCORD_CODING_STATUS_SHOW_PROJECT',
  'DISCORD_CODING_STATUS_SHOW_MODEL',
  'DISCORD_CODING_STATUS_SHOW_QUOTA',
  'DISCORD_CODING_STATUS_SHOW_CONTEXT',
  'DISCORD_CODING_STATUS_SHOW_PACKAGE'
]);

export function createConfigEditorFields(defaultStateFile: string): ConfigEditorField[] {
  return [
    {
      key: 'DISCORD_CODING_STATUS_DETAIL_LEVEL',
      label: 'Detail level',
      defaultValue: DEFAULT_DETAIL_LEVEL,
      choices: ['project', 'safe', 'full']
    },
    {
      key: 'DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE',
      label: 'Codex quota source',
      defaultValue: DEFAULT_CODEX_QUOTA_SOURCE,
      choices: ['oauth', 'auto', 'rpc', 'off']
    },
    {
      key: 'DISCORD_CODING_STATUS_ACTIVITY_STYLE',
      label: 'Activity style',
      defaultValue: DEFAULT_ACTIVITY_STYLE,
      choices: ['fun', 'normal', 'technical', 'minimal']
    },
    {
      key: 'DISCORD_CODING_STATUS_PLAN_TEXT',
      label: 'Plan override',
      defaultValue: ''
    },
    {
      key: 'DISCORD_CODING_STATUS_LIMITS_TEXT',
      label: 'Limits override',
      defaultValue: ''
    },
    {
      key: 'DISCORD_CODING_STATUS_CODEX_AUTH_FILE',
      label: 'Codex auth file',
      defaultValue: DEFAULT_CODEX_AUTH_FILE
    },
    {
      key: 'DISCORD_CODING_STATUS_STATE_FILE',
      label: 'State file',
      defaultValue: defaultStateFile
    },
    {
      key: 'DISCORD_CODING_STATUS_CLAUDE_IMAGE_KEY',
      label: 'Claude image key',
      defaultValue: ''
    },
    {
      key: 'DISCORD_CODING_STATUS_CODEX_IMAGE_KEY',
      label: 'Codex image key',
      defaultValue: ''
    },
    {
      key: 'DISCORD_CODING_STATUS_PREFER_CODEX_CLI',
      label: 'Prefer Codex CLI',
      defaultValue: 'false',
      choices: ['false', 'true']
    }
  ];
}

export const CONFIG_TUI_ITEMS: ConfigTuiItem[] = [
  { key: 'DISCORD_CODING_STATUS_SHOW_ACTIVITY', label: 'Activity', section: 'Top line', kind: 'toggle' },
  { key: 'DISCORD_CODING_STATUS_SHOW_PROJECT', label: 'Project + branch', section: 'Top line', kind: 'toggle' },
  { key: 'DISCORD_CODING_STATUS_SHOW_MODEL', label: 'Model + effort', section: 'Bottom line', kind: 'toggle' },
  { key: 'DISCORD_CODING_STATUS_SHOW_QUOTA', label: 'Plan + quota', section: 'Bottom line', kind: 'toggle' },
  { key: 'DISCORD_CODING_STATUS_SHOW_CONTEXT', label: 'Context usage', section: 'Bottom line', kind: 'toggle' },
  { key: 'DISCORD_CODING_STATUS_SHOW_PACKAGE', label: 'Package (package.json)', section: 'Bottom line', kind: 'toggle' },
  {
    key: 'DISCORD_CODING_STATUS_DETAIL_LEVEL',
    label: 'Privacy preset',
    section: 'Behavior',
    kind: 'choice',
    choices: ['safe', 'project', 'full']
  },
  {
    key: 'DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE',
    label: 'Codex quota source',
    section: 'Behavior',
    kind: 'choice',
    choices: ['oauth', 'auto', 'rpc', 'off']
  },
  {
    key: 'DISCORD_CODING_STATUS_ACTIVITY_STYLE',
    label: 'Activity style',
    section: 'Behavior',
    kind: 'choice',
    choices: ['fun', 'normal', 'technical', 'minimal']
  },
  {
    key: 'DISCORD_CODING_STATUS_PREFER_CODEX_CLI',
    label: 'Prefer Codex CLI',
    section: 'Behavior',
    kind: 'choice',
    choices: ['false', 'true']
  }
];
