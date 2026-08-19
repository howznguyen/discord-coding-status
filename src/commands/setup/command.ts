'use strict';

import { createColors } from 'picocolors';
import type { SetupToolDetection } from '../../core/detection/types';
import type { HookInstaller, ToolProvider } from '../../core/providers/types';
import type { SetupHookSummary } from './types';
import { shouldInstallHooksFor } from './policy';
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
  installers: readonly HookInstaller[];
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
  const selectedInstallers = context.installers.filter((installer) =>
    shouldInstallHooksFor(installer.capability, args, detections, context.providers));
  const selectedCapabilities = new Set(selectedInstallers.map((installer) => installer.capability));

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
      hooks: Object.fromEntries(context.installers.map((installer) => {
        const capability = installer.capability;
        const forced = Boolean(args[`${capability}-hooks`] || args[`${capability}_hooks`]);
        const disabled = Boolean(args[`no-${capability}-hooks`] || args[`no_${capability}_hooks`]);
        return [capability, {
          label: installer.label,
          install: selectedCapabilities.has(capability),
          mode: forced ? 'forced' : (disabled ? 'disabled' : 'auto')
        }];
      })),
      startup: context.defaultStartupPath
    }, null, 2));
    return true;
  }

  context.writeSetupConfig(args);
  const scriptPath = context.copyRuntime();
  const startupTarget = context.installStartup(scriptPath, startNow);
  const hookResults: Record<string, SetupHookSummary | null> = {};
  const hookNotes = new Set<string>();
  for (const installer of context.installers) {
    if (!selectedCapabilities.has(installer.capability)) {
      hookResults[installer.capability] = null;
      continue;
    }

    const result = installer.install(scriptPath);
    hookResults[installer.capability] = {
      installed: result.installed,
      removed: result.removed,
      file: result.target
    };
    for (const note of installer.notes ?? []) {
      hookNotes.add(note);
    }
  }

  const tools = buildSetupToolRows({
    detections,
    providers: context.providers,
    hookResults,
    opencodePluginInstalled: context.isOpencodePluginInstalled(),
    piExtensionInstalled: context.isPiExtensionInstalled(),
    args
  });

  const notes: string[] = [...hookNotes];
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
