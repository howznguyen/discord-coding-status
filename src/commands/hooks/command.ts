'use strict';

import { createColors } from 'picocolors';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface HooksCommandContext {
  appTitle: string;
  getRuntimeScriptPath: () => string;
  codex: {
    install: (scriptPath: string) => { installed: number; hooksFile: string; removed?: number };
    uninstall: () => { removed: number; hooksFile: string };
    printStatus: () => void;
  };
  claude: {
    install: (scriptPath: string) => { installed: number; settingsFile: string; removed?: number };
    uninstall: () => { removed: number; settingsFile: string };
    printStatus: () => void;
  };
  grok: {
    install: (scriptPath: string) => { installed: number; hooksFile: string; removed?: number };
    uninstall: () => { removed: number; hooksFile: string };
    printStatus: () => void;
  };
}

export function runHooksCommand(
  command: string,
  context: HooksCommandContext
): boolean {
  // Codex
  if (['setup-codex-hooks', 'install-codex-hooks', 'uninstall-codex-hooks', 'codex-hooks-status'].includes(command)) {
    if (command === 'codex-hooks-status') {
      context.codex.printStatus();
      return true;
    }
    if (command === 'uninstall-codex-hooks') {
      const result = context.codex.uninstall();
      console.log(`${pc.green(`✔ Removed ${result.removed}`)} ${context.appTitle} Codex hook(s) from ${pc.cyan(result.hooksFile)}.`);
      return true;
    }
    const scriptPath = context.getRuntimeScriptPath();
    const result = context.codex.install(scriptPath);
    console.log(`${pc.green(`✔ Installed ${result.installed}`)} ${context.appTitle} Codex hook(s) in ${pc.cyan(result.hooksFile)}.`);
    if (result.removed) {
      console.log(pc.yellow(`Replaced ${result.removed} existing ${context.appTitle} hook(s).`));
    }
    console.log(pc.yellow('Open Codex and run `/hooks` once to review and trust the new hooks.'));
    return true;
  }

  // Claude
  if ([
    'setup-claude-hooks',
    'install-claude-hooks',
    'enable-claude-hooks',
    'disable-claude-hooks',
    'uninstall-claude-hooks',
    'claude-hooks-status'
  ].includes(command)) {
    if (command === 'claude-hooks-status') {
      context.claude.printStatus();
      return true;
    }
    if (command === 'disable-claude-hooks' || command === 'uninstall-claude-hooks') {
      const result = context.claude.uninstall();
      console.log(`${pc.green(`✔ Removed ${result.removed}`)} ${context.appTitle} Claude hook(s) from ${pc.cyan(result.settingsFile)}.`);
      return true;
    }
    const scriptPath = context.getRuntimeScriptPath();
    const result = context.claude.install(scriptPath);
    console.log(`${pc.green(`✔ Installed ${result.installed}`)} ${context.appTitle} Claude hook(s) in ${pc.cyan(result.settingsFile)}.`);
    if (result.removed) {
      console.log(pc.yellow(`Replaced ${result.removed} existing ${context.appTitle} Claude hook(s).`));
    }
    return true;
  }

  // Grok
  if ([
    'setup-grok-hooks',
    'install-grok-hooks',
    'enable-grok-hooks',
    'disable-grok-hooks',
    'uninstall-grok-hooks',
    'grok-hooks-status'
  ].includes(command)) {
    if (command === 'grok-hooks-status') {
      context.grok.printStatus();
      return true;
    }
    if (command === 'disable-grok-hooks' || command === 'uninstall-grok-hooks') {
      const result = context.grok.uninstall();
      console.log(`${pc.green(`✔ Removed ${result.removed}`)} ${context.appTitle} Grok hook(s) from ${pc.cyan(result.hooksFile)}.`);
      return true;
    }
    const scriptPath = context.getRuntimeScriptPath();
    const result = context.grok.install(scriptPath);
    console.log(`${pc.green(`✔ Installed ${result.installed}`)} ${context.appTitle} Grok hook(s) in ${pc.cyan(result.hooksFile)}.`);
    if (result.removed) {
      console.log(pc.yellow(`Replaced ${result.removed} existing ${context.appTitle} Grok hook(s).`));
    }
    console.log(pc.dim('Grok hooks live in the globally trusted ~/.grok/hooks directory.'));
    return true;
  }

  return false;
}
