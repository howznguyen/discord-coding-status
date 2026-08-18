'use strict';

import * as os from 'node:os';
import * as path from 'node:path';
import { createColors } from 'picocolors';
import type { HookSessionState } from '../../core/hooks/types';
import { padVisible } from '../setup/summary';
import type { ActivitySummaryItem, StatusSummaryContext } from './types';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export function formatTimeAgo(timestampMs: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function toolDisplayName(tool: string): string {
  const normalized = tool.toLowerCase();
  if (normalized.includes('claude')) return 'Claude Code';
  if (normalized.includes('codex')) return 'Codex';
  if (normalized.includes('grok')) return 'Grok';
  if (normalized.includes('opencode')) return 'OpenCode';
  if (normalized.includes('pi')) return 'Pi';
  return tool;
}

export function resolveProjectName(project?: string, cwd?: string): string {
  if (project && project.trim()) {
    return project.trim();
  }
  if (!cwd || !cwd.trim()) {
    return '~';
  }
  const cleanCwd = cwd.trim();
  const homedir = os.homedir();
  if (cleanCwd === homedir || cleanCwd === path.dirname(homedir)) {
    return '~';
  }
  const basename = path.basename(cleanCwd);
  return basename || cleanCwd;
}

export function sessionToActivityItem(session: HookSessionState, now = Date.now()): ActivitySummaryItem {
  return {
    tool: toolDisplayName(session.tool),
    sessionId: session.session_id,
    project: resolveProjectName(session.project, session.cwd),
    activity: session.activity,
    model: session.model,
    effort: session.effort,
    status: session.status,
    timeAgo: formatTimeAgo(session.updated_at, now)
  };
}

export function renderStatusSummary(context: StatusSummaryContext): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${pc.bold(pc.cyan(context.appTitle))} ${pc.dim(context.version)} ${pc.dim(`by ${context.author}`)}`);
  lines.push(`${pc.bold('Status & Live Activities')}\n`);

  const colTool = 14;
  const colDetect = 15;
  const colIntegration = 38;

  // System Table
  if (context.system.length > 0) {
    lines.push(`  ${padVisible(pc.bold('Service'), colTool)} │ ${padVisible(pc.bold('Status'), colDetect)} │ ${pc.bold('Target / Details')}`);
    lines.push(`  ${'─'.repeat(colTool)}─┼─${'─'.repeat(colDetect)}─┼─${'─'.repeat(colIntegration)}`);
    for (const sys of context.system) {
      lines.push(`  ${padVisible(sys.name, colTool)} │ ${padVisible(sys.status, colDetect)} │ ${sys.target}`);
    }
    lines.push('');
  }

  // Tool Table
  if (context.tools.length > 0) {
    lines.push(`  ${padVisible(pc.bold('AI Tool'), colTool)} │ ${padVisible(pc.bold('Detection'), colDetect)} │ ${pc.bold('Hooks / Integration')}`);
    lines.push(`  ${'─'.repeat(colTool)}─┼─${'─'.repeat(colDetect)}─┼─${'─'.repeat(colIntegration)}`);
    for (const tool of context.tools) {
      lines.push(`  ${padVisible(tool.name, colTool)} │ ${padVisible(tool.detection, colDetect)} │ ${tool.integration}`);
    }
    lines.push('');
  }

  // Quotas Section
  if (context.quotas && context.quotas.length > 0) {
    lines.push(`  ${padVisible(pc.bold('OAuth Quota'), colTool)} │ ${padVisible(pc.bold('Status'), colDetect)} │ ${pc.bold('Usage / Plan')}`);
    lines.push(`  ${'─'.repeat(colTool)}─┼─${'─'.repeat(colDetect)}─┼─${'─'.repeat(colIntegration)}`);
    for (const quota of context.quotas) {
      lines.push(`  ${padVisible(quota.tool, colTool)} │ ${padVisible(quota.status, colDetect)} │ ${quota.detail}`);
    }
    lines.push('');
  }

  // Activities Section
  lines.push(`  ${pc.bold('Active Activities (Hooks Verification)')}`);
  lines.push(`  ${'─'.repeat(colTool + colDetect + colIntegration + 6)}`);

  if (context.activities.length === 0) {
    lines.push(`  ${pc.dim('· No active sessions recorded.')}`);
    lines.push(`  ${pc.dim('  Run your AI CLI (Claude, Codex, Grok, etc.) in a project to test live hooks.')}`);
  } else {
    for (const act of context.activities) {
      const toolTag = pc.green(`⚡ ${act.tool}`);
      const projectTag = act.project ? pc.cyan(act.project) : pc.dim('~');
      const modelTag = act.model ? pc.dim(`[${act.model}${act.effort ? ` · ${act.effort}` : ''}]`) : '';
      const activityText = act.activity ? act.activity : (act.status === 'waiting_input' ? 'Waiting for input' : act.status);
      const timeTag = pc.dim(act.timeAgo);

      lines.push(`  ${padVisible(toolTag, colTool + 2)} │ ${padVisible(projectTag, colDetect)} │ ${activityText} ${modelTag} ${timeTag}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
