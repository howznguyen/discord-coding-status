'use strict';

import * as readline from 'node:readline/promises';
import { createColors } from 'picocolors';
import type { ConfigEditorField } from './types';
import {
  DEFAULT_CODEX_AUTH_FILE,
  DEFAULT_CODEX_QUOTA_SOURCE,
  DEFAULT_DETAIL_LEVEL
} from './schema';
import {
  normalizeCodexQuotaSource,
  normalizeDetailLevel
} from './settings';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

function formatConfigValue(value: string | undefined): string {
  if (!value) {
    return pc.dim('(empty)');
  }
  return pc.cyan(value);
}

function configFieldHelp(field: ConfigEditorField): string {
  return field.choices ? pc.dim(` choices: ${field.choices.join('/')}`) : '';
}

export async function promptConfigField(
  rl: readline.Interface,
  field: ConfigEditorField,
  currentOverride: string
): Promise<string> {
  const effectiveValue = currentOverride || field.defaultValue;
  const currentText = effectiveValue || '(empty)';

  while (true) {
    const answer = (await rl.question(
      `${field.label}${configFieldHelp(field)} ${pc.dim(`[${currentText}]`)}: `
    )).trim();

    if (!answer) {
      return currentOverride;
    }

    if (answer === '-') {
      return '';
    }

    if (field.choices && !field.choices.includes(answer)) {
      console.log(pc.yellow(`Invalid value. Use one of: ${field.choices.join(', ')}`));
      continue;
    }

    return answer;
  }
}

export function printEffectiveConfig(
  entries: Record<string, string>,
  fields: ConfigEditorField[],
  configFile: string
): void {
  console.log(pc.bold(pc.cyan('Discord Coding Status advanced config')));
  console.log(`${pc.bold('File:')} ${pc.cyan(configFile)}`);
  console.log(pc.dim('Enter keeps the current/default value. Use "-" to clear an override.'));
  console.log('');

  for (const field of fields) {
    const override = entries[field.key] || '';
    const effective = override || field.defaultValue;
    const suffix = override ? '' : pc.dim(' (default)');
    console.log(`  ${pc.bold(field.label)}: ${formatConfigValue(effective)}${suffix}`);
  }

  console.log('');
}

export async function runAdvancedConfigEditor(
  existing: Record<string, string>,
  fields: ConfigEditorField[],
  configFile: string
): Promise<Record<string, string>> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    printEffectiveConfig(existing, fields, configFile);
    const updated: Record<string, string> = { ...existing };

    for (const field of fields) {
      const current = existing[field.key] || '';
      const next = await promptConfigField(rl, field, current);

      if (!next) {
        delete updated[field.key];
      } else {
        updated[field.key] = next;
      }
    }

    const detailLevel = normalizeDetailLevel(
      updated.DISCORD_CODING_STATUS_DETAIL_LEVEL || DEFAULT_DETAIL_LEVEL
    );
    const quotaSource = normalizeCodexQuotaSource(
      updated.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE || DEFAULT_CODEX_QUOTA_SOURCE
    );

    if (detailLevel === DEFAULT_DETAIL_LEVEL) {
      delete updated.DISCORD_CODING_STATUS_DETAIL_LEVEL;
    }
    if (quotaSource === DEFAULT_CODEX_QUOTA_SOURCE) {
      delete updated.DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE;
    }
    if (updated.DISCORD_CODING_STATUS_CODEX_AUTH_FILE === DEFAULT_CODEX_AUTH_FILE) {
      delete updated.DISCORD_CODING_STATUS_CODEX_AUTH_FILE;
    }

    return updated;
  } finally {
    rl.close();
  }
}
