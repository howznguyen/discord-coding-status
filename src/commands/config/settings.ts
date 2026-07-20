'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodexQuotaSource } from '../../core/quota/types';
import type { ActivityStyle, DetailLevel, DisplayLayout } from './types';
import {
  DEFAULT_ACTIVITY_STYLE,
  DEFAULT_CODEX_QUOTA_SOURCE,
  DEFAULT_DETAIL_LEVEL,
  JSON_CONFIG_ALIASES
} from './schema';

type ConfigErrorHandler = (message: string, error: unknown) => void;

export function parseDotEnv(content: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }

    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key) {
      entries[key] = value;
    }
  }

  return entries;
}

export function parseJsonConfig(content: string): Record<string, string> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key || value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      entries[JSON_CONFIG_ALIASES[key] || key] = String(value);
    }
  }

  return entries;
}

export function readJsonConfigFile(
  filePath: string,
  onError: ConfigErrorHandler = () => {}
): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    return parseJsonConfig(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    onError(`Failed to read JSON config file ${filePath}`, error);
    return {};
  }
}

export function loadEnvironmentFiles(
  configFile: string,
  legacyConfigFile: string,
  currentDirectory: string,
  onError: ConfigErrorHandler = () => {}
): void {
  const applyEntries = (entries: Record<string, string>): void => {
    for (const [key, value] of Object.entries(entries)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  };

  applyEntries(readJsonConfigFile(configFile, onError));
  for (const filePath of [legacyConfigFile, path.join(currentDirectory, '.env')]) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      applyEntries(parseDotEnv(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      onError(`Failed to read env file ${filePath}`, error);
    }
  }
}

export function envValue(name: string, fallback = ''): string {
  return process.env[name] === undefined ? fallback : process.env[name] || '';
}

export function envPathValue(name: string, fallback: string): string {
  return envValue(name).trim() || fallback;
}

export function resolveHomePath(value: string): string {
  if (value === '~') {
    return os.homedir() || value;
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir() || '', value.slice(2));
  }

  return path.resolve(value);
}

export function normalizeDetailLevel(value: string): DetailLevel {
  const normalized = String(value || '').trim().toLowerCase();
  return ['safe', 'project', 'full'].includes(normalized)
    ? normalized as DetailLevel
    : 'safe';
}

export function normalizeCodexQuotaSource(value: string): CodexQuotaSource {
  const normalized = String(value || '').trim().toLowerCase();
  return ['off', 'rpc', 'oauth', 'auto'].includes(normalized)
    ? normalized as CodexQuotaSource
    : DEFAULT_CODEX_QUOTA_SOURCE;
}

export function normalizeActivityStyle(value: string): ActivityStyle {
  const normalized = String(value || '').trim().toLowerCase();
  return ['fun', 'normal', 'technical', 'minimal'].includes(normalized)
    ? normalized as ActivityStyle
    : DEFAULT_ACTIVITY_STYLE;
}

export function parseBoolean(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function parseOptionalBoolean(value: string | null | undefined): boolean | null {
  if (value === null || value === undefined || !String(value).trim()) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return null;
}

export function displaySettingFromEnvironment(name: string, defaultValue: boolean): boolean {
  return parseOptionalBoolean(process.env[name]) ?? defaultValue;
}

export function defaultDisplayLayout(detailLevel: DetailLevel): DisplayLayout {
  return {
    activity: true,
    project: detailLevel === 'project' || detailLevel === 'full',
    model: true,
    quota: detailLevel === 'project' || detailLevel === 'full',
    context: false,
    package: detailLevel === 'full'
  };
}

export function displayLayoutFromEntries(entries: Record<string, string>): DisplayLayout {
  const detailLevel = normalizeDetailLevel(
    entries.DISCORD_CODING_STATUS_DETAIL_LEVEL || DEFAULT_DETAIL_LEVEL
  );
  const defaults = defaultDisplayLayout(detailLevel);

  return {
    activity: parseOptionalBoolean(entries.DISCORD_CODING_STATUS_SHOW_ACTIVITY) ?? defaults.activity,
    project: parseOptionalBoolean(entries.DISCORD_CODING_STATUS_SHOW_PROJECT) ?? defaults.project,
    model: parseOptionalBoolean(entries.DISCORD_CODING_STATUS_SHOW_MODEL) ?? defaults.model,
    quota: parseOptionalBoolean(entries.DISCORD_CODING_STATUS_SHOW_QUOTA) ?? defaults.quota,
    context: parseOptionalBoolean(entries.DISCORD_CODING_STATUS_SHOW_CONTEXT) ?? defaults.context,
    package: parseOptionalBoolean(entries.DISCORD_CODING_STATUS_SHOW_PACKAGE) ?? defaults.package
  };
}
