'use strict';

import { createColors } from 'picocolors';
import type { HookInstaller } from '../../core/providers/types';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export const HOOK_ACTIONS = ['setup', 'uninstall', 'status'] as const;
export type HookAction = (typeof HOOK_ACTIONS)[number];

export interface HooksCommandContext {
  appTitle: string;
  getRuntimeScriptPath: () => string;
  installers: readonly HookInstaller[];
  detectedInstallers: () => HookInstaller[];
  findInstaller: (harness: string) => HookInstaller | null;
}

function normalizeAction(value: string | undefined): HookAction | null {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'install') {
    return 'setup';
  }
  if (normalized === 'remove') {
    return 'uninstall';
  }
  return (HOOK_ACTIONS as readonly string[]).includes(normalized)
    ? (normalized as HookAction)
    : null;
}

function usage(context: HooksCommandContext): string {
  const names = context.installers.map((installer) => installer.capability).join(' | ');
  return [
    `${pc.bold('Usage:')} discord-coding-status hooks <${HOOK_ACTIONS.join('|')}> [harness...]`,
    '',
    `  ${pc.dim('harness:')} ${names}`,
    `  ${pc.dim('Omit the harness to apply the action to every detected harness.')}`,
    '',
    `${pc.bold('Examples:')}`,
    '  discord-coding-status hooks setup',
    '  discord-coding-status hooks setup codex grok',
    '  discord-coding-status hooks uninstall grok',
    '  discord-coding-status hooks status'
  ].join('\n');
}

/**
 * Resolves the harness arguments to installers. With no argument the action
 * applies to every detected harness for `setup`, and to every known harness for
 * `uninstall` and `status` — removing or reporting hooks must still work after
 * the harness itself has been uninstalled.
 */
function resolveInstallers(
  action: HookAction,
  harnesses: readonly string[],
  context: HooksCommandContext
): HookInstaller[] | null {
  if (harnesses.length === 0) {
    return action === 'setup' ? context.detectedInstallers() : [...context.installers];
  }

  const resolved: HookInstaller[] = [];
  const unknown: string[] = [];

  for (const harness of harnesses) {
    const installer = context.findInstaller(harness);
    if (!installer) {
      unknown.push(harness);
      continue;
    }
    if (!resolved.includes(installer)) {
      resolved.push(installer);
    }
  }

  if (unknown.length > 0) {
    const known = context.installers.map((installer) => installer.capability).join(', ');
    console.error(pc.red(`✖ Unknown harness: ${unknown.join(', ')}`));
    console.error(pc.dim(`  Known harnesses: ${known}`));
    return null;
  }

  return resolved;
}

function runSetup(installers: readonly HookInstaller[], context: HooksCommandContext): void {
  const scriptPath = context.getRuntimeScriptPath();
  const notes = new Set<string>();

  for (const installer of installers) {
    const result = installer.install(scriptPath);
    console.log(
      `${pc.green(`✔ Installed ${result.installed}`)} ${context.appTitle} ${installer.label} hook(s) in ${pc.cyan(result.target)}.`
    );
    if (result.removed) {
      console.log(pc.yellow(`  Replaced ${result.removed} existing ${context.appTitle} ${installer.label} hook(s).`));
    }
    for (const note of installer.notes ?? []) {
      notes.add(note);
    }
  }

  for (const note of notes) {
    console.log(pc.yellow(note));
  }
}

function runUninstall(installers: readonly HookInstaller[], context: HooksCommandContext): void {
  for (const installer of installers) {
    const result = installer.uninstall();
    console.log(
      `${pc.green(`✔ Removed ${result.removed}`)} ${context.appTitle} ${installer.label} hook(s) from ${pc.cyan(result.target)}.`
    );
  }
}

function runStatus(installers: readonly HookInstaller[]): void {
  const harnesses: Record<string, unknown> = {};

  for (const installer of installers) {
    const status = installer.status();
    harnesses[installer.capability] = {
      label: installer.label,
      ...status
    };
  }

  console.log(JSON.stringify({ harnesses }, null, 2));
}

export function runHooksCommand(
  command: string,
  positionals: readonly string[],
  context: HooksCommandContext
): boolean {
  if (command.trim().toLowerCase() !== 'hooks') {
    return false;
  }

  const action = normalizeAction(positionals[0]);
  if (!action) {
    if (positionals[0]) {
      console.error(pc.red(`✖ Unknown hooks action: ${positionals[0]}`));
    }
    console.log(usage(context));
    process.exitCode = positionals[0] ? 1 : 0;
    return true;
  }

  const installers = resolveInstallers(action, positionals.slice(1), context);
  if (!installers) {
    process.exitCode = 1;
    return true;
  }

  if (installers.length === 0) {
    console.log(pc.yellow('No harness with lifecycle hooks was detected on this machine.'));
    console.log(pc.dim('Name one explicitly to install anyway, e.g. `hooks setup codex`.'));
    return true;
  }

  if (action === 'setup') {
    runSetup(installers, context);
    return true;
  }

  if (action === 'uninstall') {
    runUninstall(installers, context);
    return true;
  }

  runStatus(installers);
  return true;
}
