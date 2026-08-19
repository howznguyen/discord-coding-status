'use strict';

import * as readlineCore from 'node:readline';
import { createColors } from 'picocolors';
import type { MenuItem } from './types';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export const MENU_ITEMS: readonly MenuItem[] = [
  {
    id: 'setup',
    label: 'Setup',
    hint: 'Install startup, runtime, and hooks for every detected harness',
    argv: ['setup'],
    section: 'Get started'
  },
  {
    id: 'config',
    label: 'Display config',
    hint: 'Edit what Discord shows, with a live two-line preview',
    argv: ['config'],
    section: 'Get started'
  },
  {
    id: 'hooks-setup',
    label: 'Install hooks',
    hint: 'Write lifecycle hooks for every detected harness',
    argv: ['hooks', 'setup'],
    section: 'Hooks'
  },
  {
    id: 'hooks-status',
    label: 'Hook status',
    hint: 'Print managed hook status for each harness as JSON',
    argv: ['hooks', 'status'],
    section: 'Hooks'
  },
  {
    id: 'hooks-uninstall',
    label: 'Remove hooks',
    hint: 'Remove only the hooks this project installed',
    argv: ['hooks', 'uninstall'],
    section: 'Hooks'
  },
  {
    id: 'status',
    label: 'Status',
    hint: 'Services, detected tools, OAuth quotas, and live activities',
    argv: ['status'],
    section: 'Inspect'
  },
  {
    id: 'daemon',
    label: 'Run daemon',
    hint: 'Start Rich Presence in the foreground (Ctrl+C to stop)',
    argv: ['daemon'],
    section: 'Inspect',
    takesOver: true
  },
  {
    id: 'help',
    label: 'Help',
    hint: 'Print the full command reference',
    argv: ['--help'],
    section: 'Inspect'
  },
  {
    id: 'quit',
    label: 'Quit',
    hint: 'Leave without changing anything',
    section: 'Inspect'
  }
];

function truncate(value: string, width: number): string {
  if (width <= 1 || value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(1, width - 1))}…`;
}

export function renderMenu(
  items: readonly MenuItem[],
  selectedIndex: number,
  header: { appTitle: string; version: string; subtitle: string }
): string {
  const terminalWidth = Math.max(48, process.stdout.columns || 100);
  const labelWidth = items.reduce((widest, item) => Math.max(widest, item.label.length), 0);
  const lines = [
    `${pc.bold(pc.cyan(header.appTitle))} ${pc.dim(header.version)}`,
    pc.dim(truncate(header.subtitle, terminalWidth - 2)),
    ''
  ];

  let currentSection: string | null = null;
  items.forEach((item, index) => {
    if (item.section !== currentSection) {
      if (currentSection !== null) {
        lines.push('');
      }
      currentSection = item.section;
      lines.push(pc.bold(item.section.toUpperCase()));
    }

    const selected = index === selectedIndex;
    const pointer = selected ? pc.cyan('›') : ' ';
    const label = selected ? pc.bold(item.label) : item.label;
    const padding = ' '.repeat(Math.max(1, labelWidth - item.label.length + 2));
    const hint = truncate(item.hint, Math.max(12, terminalWidth - labelWidth - 8));
    lines.push(` ${pointer} ${label}${padding}${pc.dim(hint)}`);
  });

  lines.push(
    '',
    pc.dim('↑/↓ move  ·  Enter run  ·  Q quit')
  );

  return `\x1b[2J\x1b[H${lines.join('\n')}`;
}

/**
 * Shows the menu and resolves with the chosen item, or null when the user quits.
 *
 * The caller runs the chosen command *after* this resolves, so the terminal is
 * fully released first — nested interactive commands such as `config` own raw
 * mode themselves and would fight the menu's key handler otherwise.
 */
export async function runMenuTui(
  items: readonly MenuItem[],
  header: { appTitle: string; version: string; subtitle: string },
  initialIndex = 0
): Promise<MenuItem | null> {
  const input = process.stdin;
  const output = process.stdout;
  const previousRawMode = Boolean(input.isRaw);
  let selectedIndex = Math.min(Math.max(initialIndex, 0), items.length - 1);

  readlineCore.emitKeypressEvents(input);

  return new Promise((resolve) => {
    let finished = false;

    const render = (): void => {
      output.write(renderMenu(items, selectedIndex, header));
    };

    const finish = (item: MenuItem | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      input.removeListener('keypress', onKeypress);
      output.removeListener('resize', render);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(previousRawMode);
      }
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      resolve(item);
    };

    const onKeypress = (
      _character: string,
      key: { name?: string; ctrl?: boolean }
    ): void => {
      const name = key?.name || '';

      if ((key?.ctrl && name === 'c') || name === 'escape' || name === 'q') {
        finish(null);
        return;
      }
      if (name === 'up' || name === 'k') {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        render();
        return;
      }
      if (name === 'down' || name === 'j') {
        selectedIndex = (selectedIndex + 1) % items.length;
        render();
        return;
      }
      if (name === 'return' || name === 'space') {
        const item = items[selectedIndex];
        finish(item.id === 'quit' ? null : item);
      }
    };

    input.on('keypress', onKeypress);
    output.on('resize', render);
    if (typeof input.setRawMode === 'function') {
      input.setRawMode(true);
    }
    input.resume();
    output.write('\x1b[?1049h\x1b[?25l');
    render();
  });
}

export async function waitForAnyKey(prompt: string): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return;
  }

  const previousRawMode = Boolean(input.isRaw);
  readlineCore.emitKeypressEvents(input);
  output.write(`\n${pc.dim(prompt)}`);

  await new Promise<void>((resolve) => {
    const onKeypress = (): void => {
      input.removeListener('keypress', onKeypress);
      input.setRawMode!(previousRawMode);
      input.pause();
      output.write('\n');
      resolve();
    };

    input.on('keypress', onKeypress);
    input.setRawMode!(true);
    input.resume();
  });
}
