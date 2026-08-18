'use strict';

import * as readlineCore from 'node:readline';
import { createColors } from 'picocolors';
import type {
  ConfigPreviewSamples,
  ConfigTuiItem,
  ConfigTuiResult,
  DisplayLayout
} from './types';
import {
  CONFIG_TUI_ITEMS,
  DEFAULT_ACTIVITY_STYLE,
  DEFAULT_CODEX_QUOTA_SOURCE,
  DEFAULT_DETAIL_LEVEL
} from './schema';
import {
  defaultDisplayLayout,
  displayLayoutFromEntries,
  normalizeActivityStyle,
  normalizeCodexQuotaSource,
  normalizeDetailLevel,
  parseOptionalBoolean
} from './settings';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export function applyDisplayLayout(entries: Record<string, string>, layout: DisplayLayout): void {
  entries.DISCORD_CODING_STATUS_SHOW_ACTIVITY = String(layout.activity);
  entries.DISCORD_CODING_STATUS_SHOW_PROJECT = String(layout.project);
  entries.DISCORD_CODING_STATUS_SHOW_MODEL = String(layout.model);
  entries.DISCORD_CODING_STATUS_SHOW_QUOTA = String(layout.quota);
  entries.DISCORD_CODING_STATUS_SHOW_CONTEXT = String(layout.context);
  entries.DISCORD_CODING_STATUS_SHOW_PACKAGE = String(layout.package);
}

export function initializeConfigTuiEntries(existing: Record<string, string>): Record<string, string> {
  const next = { ...existing };
  const detailLevel = normalizeDetailLevel(
    existing.DISCORD_CODING_STATUS_DETAIL_LEVEL || DEFAULT_DETAIL_LEVEL
  );

  next.DISCORD_CODING_STATUS_DETAIL_LEVEL = detailLevel;
  next.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE = normalizeCodexQuotaSource(
    existing.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE || DEFAULT_CODEX_QUOTA_SOURCE
  );
  next.DISCORD_CODING_STATUS_ACTIVITY_STYLE = normalizeActivityStyle(
    existing.DISCORD_CODING_STATUS_ACTIVITY_STYLE || DEFAULT_ACTIVITY_STYLE
  );
  next.DISCORD_CODING_STATUS_PREFER_CODEX_CLI = String(
    parseOptionalBoolean(existing.DISCORD_CODING_STATUS_PREFER_CODEX_CLI) ?? false
  );
  applyDisplayLayout(next, displayLayoutFromEntries(existing));
  return next;
}

function activityStylePreview(style: string, fallback: string): string {
  if (style === 'normal') {
    return 'Running a command';
  }
  if (style === 'technical') {
    return 'Running Bash';
  }
  if (style === 'minimal') {
    return 'Working';
  }
  return fallback;
}

export function configPreviewLines(
  entries: Record<string, string>,
  samples: ConfigPreviewSamples
): { top: string; bottom: string } {
  const layout = displayLayoutFromEntries(entries);
  const activityStyle = normalizeActivityStyle(
    entries.DISCORD_CODING_STATUS_ACTIVITY_STYLE || DEFAULT_ACTIVITY_STYLE
  );
  const quotaSource = normalizeCodexQuotaSource(
    entries.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE || DEFAULT_CODEX_QUOTA_SOURCE
  );
  const planOverride = String(entries.DISCORD_CODING_STATUS_PLAN_TEXT || '').trim();
  const limitsOverride = String(entries.DISCORD_CODING_STATUS_LIMITS_TEXT || '').trim();
  const quota = planOverride || limitsOverride
    ? [planOverride || 'Pro', limitsOverride || '5h 82% • weekly 54%'].filter(Boolean).join(' • ')
    : (quotaSource === 'off' ? 'Codex quota disabled' : samples.quota);

  const topParts = [
    layout.activity ? activityStylePreview(activityStyle, samples.activity) : null,
    layout.project ? samples.project : null
  ].filter(Boolean);

  const bottomParts = [
    layout.model ? samples.model : null,
    layout.quota ? quota : null,
    layout.context ? samples.context : null,
    layout.package ? samples.package : null
  ].filter(Boolean);

  return {
    top: topParts.join(' | '),
    bottom: bottomParts.join(' | ')
  };
}

function tuiChoiceValue(item: ConfigTuiItem, entries: Record<string, string>): string {
  const choices = item.choices || [];
  const value = String(entries[item.key] || '').trim();
  return choices.includes(value) ? value : (choices[0] || value);
}

function truncateTerminalText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return maxLength > 3 ? `${value.slice(0, maxLength - 3)}...` : value.slice(0, maxLength);
}

export function renderConfigTui(
  entries: Record<string, string>,
  samples: ConfigPreviewSamples,
  selectedIndex: number,
  notice: string,
  appTitle = 'Discord Coding Status',
  configFile = 'config.json'
): string {
  const preview = configPreviewLines(entries, samples);
  const terminalWidth = Math.max(48, process.stdout.columns || 100);
  const previewWidth = Math.max(24, terminalWidth - 11);
  const lines = [
    pc.bold(pc.cyan(`${appTitle} · Display Config`)),
    pc.dim(`File: ${truncateTerminalText(configFile, terminalWidth - 6)}`),
    '',
    pc.bold('LIVE PREVIEW') + pc.dim('  sample data · Discord uses up to 128 characters per line'),
    `  ${pc.dim('Top   ')} ${preview.top ? truncateTerminalText(preview.top, previewWidth) : pc.dim('(hidden)')}`,
    `  ${pc.dim('Bottom')} ${preview.bottom ? truncateTerminalText(preview.bottom, previewWidth) : pc.dim('(hidden)')}`,
    ''
  ];
  let currentSection: ConfigTuiItem['section'] | null = null;

  CONFIG_TUI_ITEMS.forEach((item, index) => {
    if (item.section !== currentSection) {
      currentSection = item.section;
      lines.push(pc.bold(item.section.toUpperCase()));
    }

    const selected = index === selectedIndex;
    const pointer = selected ? pc.cyan('›') : ' ';
    let control: string;
    let controlLength: number;

    if (item.kind === 'toggle') {
      const enabled = parseOptionalBoolean(entries[item.key]) ?? false;
      control = enabled ? pc.green('[x]') : pc.dim('[ ]');
      controlLength = 3;
    } else {
      const value = tuiChoiceValue(item, entries);
      control = `${pc.dim('‹')} ${pc.cyan(value)} ${pc.dim('›')}`;
      controlLength = value.length + 4;
    }

    const label = selected ? pc.bold(item.label) : item.label;
    lines.push(` ${pointer} ${control}${' '.repeat(Math.max(1, 18 - controlLength))} ${label}`);
  });

  lines.push(
    '',
    notice ? pc.yellow(notice) : pc.dim('Changes are written only when you save.'),
    pc.dim('↑/↓ move  ·  Space/Enter toggle  ·  ←/→ change'),
    pc.dim('R preset  ·  A advanced  ·  S save  ·  Q cancel')
  );

  return `\x1b[2J\x1b[H${lines.join('\n')}`;
}

export function cycleConfigTuiChoice(
  entries: Record<string, string>,
  item: ConfigTuiItem,
  direction: number
): string {
  const choices = item.choices || [];
  if (!choices.length) {
    return '';
  }

  const current = tuiChoiceValue(item, entries);
  const currentIndex = Math.max(0, choices.indexOf(current));
  const nextIndex = (currentIndex + direction + choices.length) % choices.length;
  const value = choices[nextIndex];
  entries[item.key] = value;

  if (item.key === 'DISCORD_CODING_STATUS_DETAIL_LEVEL') {
    applyDisplayLayout(entries, defaultDisplayLayout(normalizeDetailLevel(value)));
    return `Applied the ${value} display preset.`;
  }

  return `${item.label} set to ${value}.`;
}

export async function runConfigTui(
  existing: Record<string, string>,
  samples: ConfigPreviewSamples,
  appTitle = 'Discord Coding Status',
  configFile = 'config.json'
): Promise<ConfigTuiResult> {
  const entries = initializeConfigTuiEntries(existing);
  const input = process.stdin;
  const output = process.stdout;
  const previousRawMode = Boolean(input.isRaw);
  let selectedIndex = 0;
  let notice = '';

  readlineCore.emitKeypressEvents(input);

  return new Promise((resolve) => {
    let finished = false;

    const render = () => {
      output.write(renderConfigTui(entries, samples, selectedIndex, notice, appTitle, configFile));
    };
    const finish = (action: ConfigTuiResult['action']) => {
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
      resolve({ action, entries });
    };
    const activateSelected = () => {
      const item = CONFIG_TUI_ITEMS[selectedIndex];
      if (item.kind === 'toggle') {
        const enabled = parseOptionalBoolean(entries[item.key]) ?? false;
        entries[item.key] = String(!enabled);
        notice = `${item.label} ${enabled ? 'hidden' : 'shown'}.`;
      } else {
        notice = cycleConfigTuiChoice(entries, item, 1);
      }
      render();
    };
    const onKeypress = (_character: string, key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
      const name = key?.name || '';

      if ((key?.ctrl && name === 'c') || name === 'escape' || name === 'q') {
        finish('cancel');
        return;
      }
      if (name === 's') {
        finish('save');
        return;
      }
      if (name === 'a') {
        finish('advanced');
        return;
      }
      if (name === 'up' || name === 'k') {
        selectedIndex = (selectedIndex - 1 + CONFIG_TUI_ITEMS.length) % CONFIG_TUI_ITEMS.length;
        notice = '';
        render();
        return;
      }
      if (name === 'down' || name === 'j') {
        selectedIndex = (selectedIndex + 1) % CONFIG_TUI_ITEMS.length;
        notice = '';
        render();
        return;
      }
      if (name === 'left' || name === 'right') {
        const item = CONFIG_TUI_ITEMS[selectedIndex];
        if (item.kind === 'choice') {
          notice = cycleConfigTuiChoice(entries, item, name === 'left' ? -1 : 1);
          render();
        }
        return;
      }
      if (name === 'r') {
        const detailLevel = normalizeDetailLevel(
          entries.DISCORD_CODING_STATUS_DETAIL_LEVEL || DEFAULT_DETAIL_LEVEL
        );
        applyDisplayLayout(entries, defaultDisplayLayout(detailLevel));
        notice = `Restored the ${detailLevel} display preset.`;
        render();
        return;
      }
      if (name === 'space' || name === 'return') {
        activateSelected();
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
