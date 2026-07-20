'use strict';

import * as path from 'node:path';

export interface ProcessDescriptor {
  line: string;
  executablePath?: string | null;
  commandLine?: string | null;
}

export interface WindowsStartApp {
  name: string;
  appId: string;
}

function processText(value: ProcessDescriptor | string): string {
  if (typeof value === 'string') {
    return value;
  }

  return [value.executablePath, value.commandLine, value.line]
    .filter(Boolean)
    .join(' ');
}

function normalizedProcessText(value: ProcessDescriptor | string): string {
  return processText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function executableBasename(value: ProcessDescriptor | string): string {
  if (typeof value !== 'string' && value.executablePath) {
    const normalized = value.executablePath.replace(/\\/g, '/');
    return path.posix.basename(normalized).toLowerCase();
  }

  const text = normalizedProcessText(value);
  const quoted = text.match(/^"([^"]+)"/);
  const executable = quoted?.[1] || text.match(/^(\S+)/)?.[1] || '';
  return path.posix.basename(executable.replace(/\\/g, '/')).toLowerCase();
}

export function parseWindowsStartApps(output: string): WindowsStartApp[] {
  const text = output.trim();
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (_) {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return [];
    }

    const record = row as Record<string, unknown>;
    const name = typeof record.Name === 'string' ? record.Name.trim() : '';
    const appId = typeof record.AppID === 'string' ? record.AppID.trim() : '';
    return name && appId ? [{ name, appId }] : [];
  });
}

export function windowsDesktopAppDetail(app: WindowsStartApp | null): string | null {
  return app ? `shell:AppsFolder\\${app.appId}` : null;
}

export function isClaudeCodeUrlHandlerProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value);
  return text.includes('claude code url handler')
    || text.includes('com.anthropic.claude-code-url-handler');
}

export function isClaudeDesktopProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  if (isClaudeCodeUrlHandlerProcess(value)) {
    return false;
  }

  const isClaudeExecutable = /(?:^|[\s/])claude(?:\.exe)?(?:\s|$)/.test(text);
  const isKnownWindowsInstall = text.includes('/windowsapps/')
    || text.includes('/program files/claude/')
    || text.includes('/appdata/local/anthropicclaude/')
    || text.includes('/appdata/local/programs/claude/')
    || text.includes('/appdata/local/claude/');
  return text.includes('/claude.app/contents/')
    || (isKnownWindowsInstall && isClaudeExecutable);
}

export function isClaudeCodeProcess(value: ProcessDescriptor | string): boolean {
  if (isClaudeDesktopProcess(value) || isClaudeCodeUrlHandlerProcess(value)) {
    return false;
  }

  const text = normalizedProcessText(value).replace(/\\/g, '/');
  const executable = executableBasename(value);
  return executable === 'claude'
    || executable === 'claude.exe'
    || executable === 'claude-code'
    || executable === 'claude-code.exe'
    || /(?:^|[\s/])claude-code(?:\.exe)?(?:\s|$)/.test(text)
    || /(?:^|[\s/])(?:bun|bunx|node|npx|npm|pnpm|yarn)\s+.*(?:@anthropic-ai\/)?claude-code(?:[/.][^\s]*)?(?:\s|$)/.test(text);
}

export function isCodexDesktopProcess(value: ProcessDescriptor | string): boolean {
  const text = normalizedProcessText(value).replace(/\\/g, '/');
  if (text.includes('/codex.app/')) {
    return true;
  }

  if (text.includes('/chatgpt.app/')) {
    return text.includes('/contents/macos/chatgpt')
      || text.includes('/frameworks/codex framework.framework/')
      || text.includes('/contents/resources/codex') && /(?:^|\s)app-server(?:\s|$)/.test(text);
  }

  const isWindowsStoreApp = text.includes('/windowsapps/') && (
    /(?:^|[\s/])chatgpt(?:\.exe)?(?:\s|$)/.test(text)
      || (text.includes('chatgpt')
        && /(?:^|[\s/])codex(?:\.exe)?(?:\s|$)/.test(text)
        && /(?:^|\s)app-server(?:\s|$)/.test(text))
  );
  const isUnpackagedWindowsHost = /(?:^|[\s/])chatgpt\.exe(?:\s|$)/.test(text);
  const isUnpackagedWindowsAppServer = text.includes('/chatgpt/')
      && /(?:^|[\s/])codex(?:\.exe)?(?:\s|$)/.test(text)
      && /(?:^|\s)app-server(?:\s|$)/.test(text);

  return isWindowsStoreApp || isUnpackagedWindowsHost || isUnpackagedWindowsAppServer;
}

export function isCodexCliProcess(value: ProcessDescriptor | string): boolean {
  if (isCodexDesktopProcess(value)) {
    return false;
  }

  const text = normalizedProcessText(value).replace(/\\/g, '/');
  const executable = executableBasename(value);
  return executable === 'codex'
    || executable === 'codex.exe'
    || /(?:^|[\s/])(?:bun|bunx|node|npx|npm|pnpm|yarn)\s+.*(?:@[\w.-]+\/)?codex(?:[/.][^\s]*)?(?:\s|$)/.test(text);
}
