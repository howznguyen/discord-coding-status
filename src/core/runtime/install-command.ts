'use strict';

export interface RuntimeInstallCommand {
  command: string;
  args: string[];
}

export interface RuntimeInstallCommandOptions {
  /** `process.env.npm_execpath`: how the invoking package manager exposes itself. */
  packageManagerPath?: string | null;
  /** Whether that path exists on disk. */
  packageManagerPathExists: boolean;
  platform: string;
  /** `process.execPath`: the JavaScript runtime executing this CLI. */
  runtimePath: string;
  /** `process.env.ComSpec`, used only on Windows. */
  comSpec?: string | null;
}

const INSTALL_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'];

function isJavaScriptEntry(value: string): boolean {
  return /\.[cm]?js$/i.test(value);
}

/**
 * Picks how to shell out to install the runtime's production dependencies.
 *
 * `npm_execpath` is not one shape. npm points it at `npm-cli.js`, yarn at
 * `yarn.js`, and pnpm at `pnpm.cjs` — JavaScript entries that only run when
 * handed to a runtime. bun points it at its own native binary, which a runtime
 * would try to parse as JavaScript and reject with a syntax error. So the
 * extension decides whether the path is an argument or the command itself.
 */
export function resolveRuntimeInstallCommand(
  options: RuntimeInstallCommandOptions
): RuntimeInstallCommand {
  const args = [...INSTALL_ARGS];
  const isWindows = options.platform === 'win32';
  const managerPath = options.packageManagerPath || '';
  const shell = options.comSpec || 'cmd.exe';

  if (managerPath && options.packageManagerPathExists) {
    if (isJavaScriptEntry(managerPath)) {
      return { command: options.runtimePath, args: [managerPath, ...args] };
    }

    // Native executables can be spawned directly. Windows `.cmd`/`.bat` shims
    // are scripts the loader cannot execute, so they need a shell.
    if (isWindows && !/\.exe$/i.test(managerPath)) {
      return { command: shell, args: ['/d', '/s', '/c', managerPath, ...args] };
    }

    return { command: managerPath, args };
  }

  if (isWindows) {
    return { command: shell, args: ['/d', '/s', '/c', 'npm', ...args] };
  }

  return { command: 'npm', args };
}
