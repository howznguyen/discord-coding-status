'use strict';

import { createColors } from 'picocolors';
import type { SetupToolDetection } from '../../core/detection/types';
import type { ToolProvider } from '../../core/providers/types';
import {
  shouldInstallClaudeHooks,
  shouldInstallCodexHooks,
  shouldInstallGrokHooks
} from './policy';
import { renderSetupSummary } from './summary';
import { buildSetupToolRows } from './tools';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface SetupCommandContext {
  appTitle: string;
  version: string;
  author: string;
  configFile: string;
  stateFile: string;
  installDirectory: string;
  codexClientId: string;
  claudeClientId: string;
  opencodeClientId: string;
  piClientId: string;
  grokClientId: string;
  providers: readonly ToolProvider[];
  getDetections: () => SetupToolDetection[];
  printStatus: (args: Record<string, string | boolean>) => Promise<void>;
  uninstallStartup: (purge: boolean) => void;
  writeSetupConfig: (args: Record<string, string | boolean>) => void;
  copyRuntime: () => string;
  installStartup: (scriptPath: string, startNow: boolean) => string;
  installCodexHooks: (scriptPath: string) => { installed: number; hooksFile: string };
  installClaudeHooks: (scriptPath: string) => { installed: number; settingsFile: string };
  installGrokHooks: (scriptPath: string) => { installed: number; hooksFile: string };
  isOpencodePluginInstalled: () => boolean;
  isPiExtensionInstalled: () => boolean;
  compactPath: (value: string) => string;
  defaultStartupPath: string;
}

export async function runSetupCommand(
  command: string,
  args: Record<string, string | boolean>,
  context: SetupCommandContext
): Promise<boolean> {
  if (!['setup', 'install', 'uninstall', 'status', 'startup-status'].includes(command)) {
    return false;
  }

  const detections = context.getDetections();

  if (command === 'status' || command === 'startup-status') {
    await context.printStatus(args);
    return true;
  }

  if (command === 'uninstall') {
    context.uninstallStartup(Boolean(args.purge));
    console.log(pc.green(`✔ ${context.appTitle} startup entry removed.`));
    return true;
  }

  const dryRun = Boolean(args['dry-run'] || args.dry_run);
  const startNow = !Boolean(args['no-start'] || args.no_start);
  const installCodexHookSet = shouldInstallCodexHooks(args, detections, context.providers);
  const installClaudeHookSet = shouldInstallClaudeHooks(args, detections, context.providers);
  const installGrokHookSet = shouldInstallGrokHooks(args, detections, context.providers);

  if (dryRun) {
    console.log(JSON.stringify({
      platform: process.platform,
      configFile: context.configFile,
      stateFile: context.stateFile,
      installDirectory: context.installDirectory,
      codexClientId: context.codexClientId,
      claudeClientId: context.claudeClientId,
      opencodeClientId: context.opencodeClientId,
      piClientId: context.piClientId,
      grokClientId: context.grokClientId,
      detectedTools: detections,
      codexHooks: {
        install: installCodexHookSet,
        mode: (args['codex-hooks'] || args.codex_hooks)
          ? 'forced'
          : ((args['no-codex-hooks'] || args.no_codex_hooks) ? 'disabled' : 'auto')
      },
      claudeHooks: {
        install: installClaudeHookSet,
        mode: (args['claude-hooks'] || args.claude_hooks)
          ? 'forced'
          : ((args['no-claude-hooks'] || args.no_claude_hooks) ? 'disabled' : 'auto')
      },
      grokHooks: {
        install: installGrokHookSet,
        mode: (args['grok-hooks'] || args.grok_hooks)
          ? 'forced'
          : ((args['no-grok-hooks'] || args.no_grok_hooks) ? 'disabled' : 'auto')
      },
      startup: context.defaultStartupPath
    }, null, 2));
    return true;
  }

  context.writeSetupConfig(args);
  const scriptPath = context.copyRuntime();
  const startupTarget = context.installStartup(scriptPath, startNow);
  const codexHooks = installCodexHookSet ? context.installCodexHooks(scriptPath) : null;
  const claudeHooks = installClaudeHookSet ? context.installClaudeHooks(scriptPath) : null;
  const grokHooks = installGrokHookSet ? context.installGrokHooks(scriptPath) : null;

  const tools = buildSetupToolRows({
    detections,
    providers: context.providers,
    claudeHooks,
    codexHooks,
    grokHooks,
    opencodePluginInstalled: context.isOpencodePluginInstalled(),
    piExtensionInstalled: context.isPiExtensionInstalled(),
    args
  });

  const notes: string[] = [];
  if (codexHooks) {
    notes.push('Codex: run `/hooks` once in Codex to review and trust new hooks.');
  }
  if (!startNow) {
    notes.push('Startup is installed; the daemon will run at next login.');
  }

  console.log(renderSetupSummary({
    appTitle: context.appTitle,
    version: context.version,
    author: context.author,
    tools,
    system: [
      {
        name: 'Startup',
        status: pc.green('✔ Active'),
        target: pc.cyan(context.compactPath(startupTarget))
      },
      {
        name: 'Config',
        status: pc.green('✔ Saved'),
        target: pc.cyan(context.compactPath(context.configFile))
      }
    ],
    notes
  }));

  return true;
}
