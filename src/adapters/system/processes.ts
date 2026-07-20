'use strict';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessInfo } from '../../core/tools/types';

const execFileAsync = promisify(execFile);
const PS_TIMEOUT_MS = 5_000;
const LSOF_TIMEOUT_MS = 2_000;

export async function getProcessList(): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    return getWindowsProcessList();
  }

  const { stdout } = await execFileAsync('ps', ['ax', '-o', 'pid=,comm=,args='], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  }) as { stdout: string };

  return stdout
    .split('\n')
    .map(parseProcessLine)
    .filter((processInfo): processInfo is ProcessInfo => Boolean(processInfo));
}

async function getWindowsProcessList(): Promise<ProcessInfo[]> {
  const command = [
    '@(Get-CimInstance Win32_Process |',
    'Select-Object ProcessId,ExecutablePath,CommandLine) |',
    'ConvertTo-Json -Compress'
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  }) as { stdout: string };

  if (!stdout.trim()) {
    return [];
  }

  const parsed = JSON.parse(stdout) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return rows
    .map((row): ProcessInfo | null => {
      const record = asRecord(row);
      const pid = extractNumberLike(record?.ProcessId);
      if (pid === null) {
        return null;
      }

      const commandLine = extractString(record?.CommandLine);
      const executablePath = extractString(record?.ExecutablePath);
      const line = [executablePath, commandLine].filter(Boolean).join(' ');

      if (!line) {
        return null;
      }

      return {
        pid,
        line,
        raw: line,
        executablePath,
        commandLine
      };
    })
    .filter((processInfo): processInfo is ProcessInfo => Boolean(processInfo));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractNumberLike(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseProcessLine(line: string): ProcessInfo | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^(\d+)\s+(.+)$/);

  if (!match) {
    return null;
  }

  return {
    pid: Number(match[1]),
    line: match[2],
    raw: trimmed
  };
}

export async function getCwdForProcess(processInfo: ProcessInfo | undefined): Promise<string | null> {
  if (!processInfo || !processInfo.pid || process.platform === 'win32') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('lsof', [
      '-a',
      '-p',
      String(processInfo.pid),
      '-d',
      'cwd',
      '-Fn'
    ], {
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 64 * 1024
    }) as { stdout: string };

    const cwdLine = stdout
      .split('\n')
      .find((line) => line.startsWith('n'));

    return cwdLine ? cwdLine.slice(1).trim() : null;
  } catch (_) {
    return null;
  }
}
