'use strict';

import { createColors } from 'picocolors';
import type { SetupSummaryContext } from './types';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function padVisible(text: string, width: number): string {
  const visibleLen = stripAnsi(text).length;
  const padding = Math.max(0, width - visibleLen);
  return text + ' '.repeat(padding);
}

export function renderSetupSummary(context: SetupSummaryContext): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${pc.bold(pc.cyan(context.appTitle))} ${pc.dim(context.version)} ${pc.dim(`by ${context.author}`)}`);
  lines.push(`${pc.green('✔')} Setup completed successfully.\n`);

  const colTool = 14;
  const colDetect = 15;
  const colIntegration = 38;

  lines.push(`  ${padVisible(pc.bold('AI Tool'), colTool)} │ ${padVisible(pc.bold('Detection'), colDetect)} │ ${pc.bold('Hooks / Integration')}`);
  lines.push(`  ${'─'.repeat(colTool)}─┼─${'─'.repeat(colDetect)}─┼─${'─'.repeat(colIntegration)}`);

  for (const tool of context.tools) {
    lines.push(`  ${padVisible(tool.name, colTool)} │ ${padVisible(tool.detection, colDetect)} │ ${tool.integration}`);
  }

  if (context.system.length > 0) {
    lines.push('');
    lines.push(`  ${padVisible(pc.bold('System'), colTool)} │ ${padVisible(pc.bold('Status'), colDetect)} │ ${pc.bold('Target / Location')}`);
    lines.push(`  ${'─'.repeat(colTool)}─┼─${'─'.repeat(colDetect)}─┼─${'─'.repeat(colIntegration)}`);

    for (const sys of context.system) {
      lines.push(`  ${padVisible(sys.name, colTool)} │ ${padVisible(sys.status, colDetect)} │ ${sys.target}`);
    }
  }

  lines.push('');

  if (context.notes && context.notes.length > 0) {
    for (const note of context.notes) {
      lines.push(`  ${pc.dim(`💡 ${note}`)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
