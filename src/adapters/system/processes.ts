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

  const { stdout } = await execFileAsync('ps', ['ax', '-o', 'pid=,time=,comm=,args='], {
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
    'Select-Object ProcessId,ExecutablePath,CommandLine,UserModeTime,KernelModeTime) |',
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

      const userModeTicks = extractNumberLike(record?.UserModeTime) || 0;
      const kernelModeTicks = extractNumberLike(record?.KernelModeTime) || 0;

      return {
        pid,
        line,
        raw: line,
        executablePath,
        commandLine,
        cpuMs: (userModeTicks + kernelModeTicks) / 10_000
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
  const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.+)$/);

  if (!match) {
    return null;
  }

  const pid = Number(match[1]);
  const cpuSeconds = parseCpuSeconds(match[2]);

  return {
    pid,
    line: match[3],
    raw: trimmed,
    cpuMs: cpuSeconds === null ? undefined : cpuSeconds * 1000
  };
}

function parseCpuSeconds(text: string): number | null {
  const value = String(text || '').trim();
  if (!value) {
    return null;
  }

  // ps prints cumulative CPU time as MM:SS.cc, HH:MM:SS[.cc], or D-HH:MM:SS[.cc]
  // when the process has accumulated a day or more of CPU time.
  let normalized = value;
  const dayMatch = normalized.match(/^(\d+)-(.+)$/);
  if (dayMatch) {
    normalized = `${Number(dayMatch[1]) * 24}:${dayMatch[2]}`;
  }

  const segments = normalized.split(':').map((segment) => {
    const [whole, fraction] = segment.split('.');
    const integer = Number(whole);
    const frac = fraction ? Number(`0.${fraction}`) : 0;
    return Number.isFinite(integer) ? integer + frac : NaN;
  });

  if (segments.some((segment) => Number.isNaN(segment)) || segments.length === 0) {
    return null;
  }

  let seconds = segments.pop() as number;
  let multiplier = 1;
  while (segments.length) {
    multiplier *= 60;
    seconds += (segments.pop() as number) * multiplier;
  }

  return seconds;
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
