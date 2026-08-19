'use strict';

import { createColors } from 'picocolors';
import type { MenuItem, MenuRunResult } from './types';
import { MENU_ITEMS, runMenuTui, waitForAnyKey } from './tui';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface MenuCommandContext {
  appTitle: string;
  version: string;
  subtitle: string;
  /**
   * True only for a real terminal on both ends. Scripts, pipes, and CI keep the
   * previous behaviour: a bare invocation prints help instead of opening a menu.
   */
  isInteractive: () => boolean;
  /** Runs the CLI again with the given argv and resolves once it exits. */
  run: (argv: readonly string[]) => Promise<MenuRunResult>;
  items?: readonly MenuItem[];
}

export function shouldOpenMenu(command: string, context: MenuCommandContext): boolean {
  return command.trim() === '' && context.isInteractive();
}

/**
 * Opens the interactive menu for a bare `npx discord-coding-status` on a TTY.
 *
 * Returns false for every other invocation — including `--help` and any
 * non-interactive bare run — so the existing command chain handles those
 * unchanged.
 */
export async function runMenuCommand(
  command: string,
  context: MenuCommandContext
): Promise<boolean> {
  if (!shouldOpenMenu(command, context)) {
    return false;
  }

  const items = context.items ?? MENU_ITEMS;
  const header = {
    appTitle: context.appTitle,
    version: context.version,
    subtitle: context.subtitle
  };
  let selectedIndex = 0;

  for (;;) {
    const choice = await runMenuTui(items, header, selectedIndex);
    if (!choice) {
      return true;
    }

    selectedIndex = Math.max(0, items.indexOf(choice));

    if (!choice.argv) {
      continue;
    }

    const result = await context.run(choice.argv);

    if (choice.takesOver) {
      process.exitCode = result.code ?? 0;
      return true;
    }

    if (result.code !== 0) {
      console.log(pc.red(`✖ ${choice.label} exited with code ${result.code ?? 'unknown'}.`));
    }

    await waitForAnyKey('Press any key to return to the menu…');
  }
}
