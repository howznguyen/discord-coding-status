'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SetupToolDetection } from '../../core/detection/types';
import type {
  DesktopInstallationProbe,
  InstallationProbe,
  ToolProvider
} from '../../core/providers/types';
import {
  parseWindowsStartApps,
  windowsDesktopAppDetail,
  type WindowsStartApp
} from '../../core/detection/tool-detection';

type ExecuteFile = (
  command: string,
  args: string[],
  timeout?: number,
  maxBuffer?: number
) => string;

export interface SetupDetectionOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  executableOverrides?: Readonly<Record<string, readonly string[]>>;
  pathOverrides?: Readonly<Record<string, string>>;
  pathExists?: (candidate: string) => boolean;
  executeFile?: ExecuteFile;
}

interface DetectionRuntime {
  platform: NodeJS.Platform;
  homeDirectory: string;
  pathExists: (candidate: string) => boolean;
  executeFile: ExecuteFile;
}

function execFileSyncString(
  command: string,
  args: string[],
  timeout = 1_000,
  maxBuffer = 64 * 1024
): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

function detectionRuntime(options: SetupDetectionOptions): DetectionRuntime {
  return {
    platform: options.platform || process.platform,
    homeDirectory: options.homeDirectory || os.homedir(),
    pathExists: options.pathExists || fs.existsSync,
    executeFile: options.executeFile || execFileSyncString
  };
}

function resolveHomePath(value: string, homeDirectory: string): string {
  if (value === '~') {
    return homeDirectory || value;
  }
  if (value.startsWith('~/')) {
    return path.join(homeDirectory, value.slice(2));
  }
  return path.resolve(value);
}

function findExecutable(command: string, runtime: DetectionRuntime): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const resolved = resolveHomePath(trimmed, runtime.homeDirectory);
    return runtime.pathExists(resolved) ? resolved : null;
  }

  try {
    const output = runtime.executeFile(
      runtime.platform === 'win32' ? 'where.exe' : 'which',
      [trimmed]
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || null;
  } catch (_) {
    return null;
  }
}

function detectWindowsStartApps(runtime: DetectionRuntime): WindowsStartApp[] {
  if (runtime.platform !== 'win32') {
    return [];
  }

  try {
    const command = '@(Get-StartApps | Select-Object Name,AppID) | ConvertTo-Json -Compress';
    return parseWindowsStartApps(runtime.executeFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      5_000,
      512 * 1024
    ));
  } catch (_) {
    return [];
  }
}

function readMacBundleIdentifier(appPath: string, runtime: DetectionRuntime): string | null {
  try {
    return runtime.executeFile('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      path.join(appPath, 'Contents', 'Info.plist')
    ]).trim() || null;
  } catch (_) {
    return null;
  }
}

function detectMacDesktopApp(
  probe: DesktopInstallationProbe,
  runtime: DetectionRuntime
): string | null {
  for (const app of probe.macCandidates) {
    const candidates = [
      path.join('/Applications', app.bundleName),
      path.join(runtime.homeDirectory, 'Applications', app.bundleName)
    ];

    for (const candidate of candidates) {
      if (!runtime.pathExists(candidate)) {
        continue;
      }
      if (app.bundleIdentifier && readMacBundleIdentifier(candidate, runtime) !== app.bundleIdentifier) {
        continue;
      }
      if (app.requiredRelativePaths?.some(
        (requiredPath) => !runtime.pathExists(path.join(candidate, requiredPath))
      )) {
        continue;
      }
      return candidate;
    }
  }

  return null;
}

function detectWindowsDesktopApp(
  probe: DesktopInstallationProbe,
  startApps: readonly WindowsStartApp[]
): string | null {
  const expectedNames = new Set(probe.windowsStartNames.map((name) => name.trim().toLowerCase()));
  const app = startApps.find((candidate) => expectedNames.has(candidate.name.trim().toLowerCase())) || null;
  return windowsDesktopAppDetail(app);
}

function detectProbe(
  provider: ToolProvider,
  probe: InstallationProbe,
  options: SetupDetectionOptions,
  runtime: DetectionRuntime,
  windowsStartApps: readonly WindowsStartApp[]
): string | null {
  if (probe.kind === 'executable') {
    const candidates = options.executableOverrides?.[provider.id] || probe.candidates;
    for (const candidate of candidates) {
      const executable = findExecutable(candidate, runtime);
      if (executable) {
        return executable;
      }
    }
    return null;
  }

  if (probe.kind === 'path') {
    const configuredPath = options.pathOverrides?.[provider.id] || probe.defaultPath;
    const resolvedPath = resolveHomePath(configuredPath, runtime.homeDirectory);
    return runtime.pathExists(resolvedPath) ? resolvedPath : null;
  }

  if (runtime.platform === 'darwin') {
    return detectMacDesktopApp(probe, runtime);
  }
  if (runtime.platform === 'win32') {
    return detectWindowsDesktopApp(probe, windowsStartApps);
  }
  return null;
}

export function detectSetupTools(
  options: SetupDetectionOptions,
  providers: readonly ToolProvider[]
): SetupToolDetection[] {
  const runtime = detectionRuntime(options);
  const windowsStartApps = detectWindowsStartApps(runtime);

  return providers
    .filter((provider) => Boolean(provider.setup))
    .sort((left, right) => left.setup!.order - right.setup!.order)
    .map((provider): SetupToolDetection => {
      const detail = detectProbe(
        provider,
        provider.setup!.probe,
        options,
        runtime,
        windowsStartApps
      );
      return {
        key: provider.id,
        name: provider.setup!.name,
        detected: Boolean(detail),
        detail
      };
    });
}
