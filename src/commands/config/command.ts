'use strict';

import { createColors } from 'picocolors';
import type { ConfigTuiResult } from './types';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface ConfigCommandContext {
  appTitle: string;
  configFile: string;
  readExistingConfig: () => Record<string, string>;
  writeConfig: (entries: Record<string, string>, options?: { action?: 'save' | 'reset'; skipRestart?: boolean }) => void;
  serializeConfig: (entries: Record<string, string>) => string;
  compactEntries: (entries: Record<string, string>) => Record<string, string>;
  getPreviewLines: (entries: Record<string, string>) => { top: string; bottom: string };
  runTui: (existing: Record<string, string>) => Promise<ConfigTuiResult>;
  runAdvancedEditor: (existing: Record<string, string>) => Promise<Record<string, string>>;
}

export async function runConfigCommand(
  command: string,
  args: Record<string, string | boolean>,
  context: ConfigCommandContext
): Promise<boolean> {
  if (!['config', 'configure'].includes(command)) {
    return false;
  }

  const existing = context.readExistingConfig();
  const skipRestart = Boolean(args['no-restart'] || args.no_restart);

  if (args.reset) {
    context.writeConfig({}, { action: 'reset', skipRestart });
    return true;
  }

  if (args.show || args.json) {
    console.log(context.serializeConfig(context.compactEntries(existing)).trim());
    return true;
  }

  if (args.preview) {
    const preview = context.getPreviewLines(existing);
    console.log(pc.bold(pc.cyan(`${context.appTitle} preview`)));
    console.log(`${pc.bold('Top:')} ${preview.top || pc.dim('(hidden)')}`);
    console.log(`${pc.bold('Bottom:')} ${preview.bottom || pc.dim('(hidden)')}`);
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(pc.red('✖ Config editor requires an interactive terminal. Use `config --show`, `config --preview`, or `config --reset` in scripts.'));
    process.exitCode = 1;
    return true;
  }

  if (args.advanced || args.prompts) {
    context.writeConfig(await context.runAdvancedEditor(existing), { skipRestart });
    return true;
  }

  const result = await context.runTui(existing);
  if (result.action === 'cancel') {
    console.log(pc.dim('Config unchanged.'));
    return true;
  }

  if (result.action === 'advanced') {
    context.writeConfig(await context.runAdvancedEditor(result.entries), { skipRestart });
    return true;
  }

  context.writeConfig(result.entries, { skipRestart });
  return true;
}
