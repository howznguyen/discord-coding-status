'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CURSOR_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
export const CURSOR_PLAN_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo';
export const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/oauth/token';
export const CURSOR_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';

export function cursorStateDbPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function sqliteQueryValue(databasePath: string, key: string): string | null {
  try {
    const sql = `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}' LIMIT 1;`;
    const stdout = execFileSync('sqlite3', [databasePath, sql], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const trimmed = String(stdout || '').trim();
    return trimmed || null;
  } catch (_) {
    return null;
  }
}

function base64Decode(value: string | null | undefined): string {
  try {
    const buffer = Buffer.from(String(value || ''), 'base64');
    return buffer.toString('utf8');
  } catch (_) {
    return '';
  }
}

function tokenSubject(accessToken: string | null | undefined): string | null {
  const decoded = base64Decode(accessToken);
  try {
    const payload = decoded.split('.')[0];
    const json = JSON.parse(payload) as Record<string, unknown>;
    return typeof json.sub === 'string' ? json.sub : null;
  } catch (_) {
    return null;
  }
}

export function cursorSessionFromToken(accessToken: string | null | undefined): { userId: string; sessionToken: string } | null {
  const subject = tokenSubject(accessToken);
  if (!subject) {
    return null;
  }
  const sessionToken = base64Decode(accessToken).split('.')[1] || '';
  return { userId: subject, sessionToken };
}

export async function readCursorAuthState(): Promise<{ accessToken?: string; refreshToken?: string; source: 'sqlite' | 'keychain' | null }> {
  const dbPath = cursorStateDbPath();
  if (!fs.existsSync(dbPath)) {
    return { source: null };
  }

  const accessToken = sqliteQueryValue(dbPath, 'cursorAuth/accessToken') || undefined;
  const refreshToken = sqliteQueryValue(dbPath, 'cursorAuth/refreshToken') || undefined;

  if (accessToken || refreshToken) {
    return { accessToken, refreshToken, source: 'sqlite' };
  }

  // Fallback to macOS keychain when the state database is not readable
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        'cursor-access-token',
        '-w'
      ], { timeout: 3000 });
      const keychainToken = String(stdout || '').trim();
      if (keychainToken) {
        return { accessToken: keychainToken, source: 'keychain' };
      }
    } catch (_) {}
  }

  return { source: null };
}

export async function fetchCursorQuotaText(): Promise<string | null> {
  const source = (process.env.DISCORD_CODING_STATUS_CURSOR_QUOTA_SOURCE || 'auto').trim().toLowerCase();
  if (source === 'off') {
    return null;
  }

  const auth = await readCursorAuthState();
  if (!auth.accessToken) {
    return null;
  }

  try {
    const response = await fetch(CURSOR_USAGE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      },
      body: '{}'
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const planUsage = (payload.planUsage || payload.usage) as Record<string, unknown> | undefined;
    if (!planUsage) {
      return null;
    }

    const totalPercentUsed = typeof planUsage.totalPercentUsed === 'number'
      ? planUsage.totalPercentUsed
      : (typeof planUsage.percentUsed === 'number' ? planUsage.percentUsed : null);
    const limit = typeof planUsage.limit === 'number' ? planUsage.limit : null;
    const remaining = typeof planUsage.remaining === 'number' ? planUsage.remaining : null;
    const used = limit !== null && remaining !== null ? limit - remaining : null;
    const percent = totalPercentUsed ?? (limit && used !== null ? (used / limit) * 100 : null);

    const planName = typeof payload.planName === 'string' && payload.planName.trim()
      ? payload.planName.trim()
      : ((typeof payload.membershipType === 'string' && payload.membershipType.trim())
          ? payload.membershipType.trim()
          : 'Cursor');

    const metrics: string[] = [];
    if (percent !== null) {
      const remainingPercent = Math.max(0, Math.min(100, 100 - percent));
      metrics.push(`${Math.round(remainingPercent)}% remaining`);
    }
    if (used !== null && limit !== null) {
      metrics.push(`${Math.round(used)}/${Math.round(limit)} requests`);
    }

    if (!metrics.length) {
      return null;
    }

    const segments = [planName, metrics.join(' • ')]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter(Boolean);

    return segments.length ? segments.join(' • ') : null;
  } catch (_) {
    return null;
  }
}
