'use strict';

export type CommandArgs = Record<string, string | boolean>;

export function parseArgs(argv: string[]): CommandArgs {
  const parsed: CommandArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex !== -1) {
      parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[withoutPrefix] = next;
      index += 1;
    } else {
      parsed[withoutPrefix] = true;
    }
  }

  return parsed;
}

/**
 * Bare (non-flag) arguments, using the same consumption rules as `parseArgs` so
 * the two agree on which tokens a flag swallowed as its value.
 */
export function parsePositionals(argv: string[]): string[] {
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    if (arg.includes('=')) {
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      index += 1;
    }
  }

  return positionals;
}

export function getArgString(args: CommandArgs, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
