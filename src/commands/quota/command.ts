'use strict';

import { createColors } from 'picocolors';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface QuotaCommandContext {
  getClaudeQuota: () => Promise<{ status: string; diagnostic?: string; quota?: { text: string } }>;
  getCodexQuota: (source?: string) => Promise<string | null>;
  getGrokQuota: () => Promise<string | null>;
  getOpencodeQuota: () => Promise<string | null>;
  defaultCodexSource: string;
}

export async function runQuotaCommand(
  command: string,
  args: Record<string, string | boolean>,
  context: QuotaCommandContext
): Promise<boolean> {
  if (!['quota', 'codex-quota'].includes(command)) {
    return false;
  }

  const requestedTool = command === 'quota'
    ? (String(args.tool || 'codex')).trim().toLowerCase()
    : 'codex';

  if (requestedTool === 'claude' || requestedTool === 'claude-code') {
    const result = await context.getClaudeQuota();
    if (result.status === 'unavailable') {
      console.error(pc.red(result.diagnostic || 'Claude quota unavailable.'));
      process.exitCode = 1;
      return true;
    }

    console.log(result.quota?.text);
    return true;
  }

  if (requestedTool === 'grok' || requestedTool === 'opencode') {
    const quotaText = requestedTool === 'grok'
      ? await context.getGrokQuota()
      : await context.getOpencodeQuota();

    if (!quotaText) {
      console.error(pc.red(`${requestedTool} quota unavailable. Ensure you are logged in and try again.`));
      process.exitCode = 1;
      return true;
    }

    console.log(quotaText);
    return true;
  }

  if (requestedTool !== 'codex') {
    console.error(pc.red(`Unsupported quota tool: ${requestedTool}. Use codex, claude, grok, or opencode.`));
    process.exitCode = 1;
    return true;
  }

  const source = String(args.source || context.defaultCodexSource);
  const quotaText = await context.getCodexQuota(source);

  if (!quotaText) {
    console.error(pc.red('Codex quota unavailable. Try --source oauth, --source rpc, or DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE=auto.'));
    process.exitCode = 1;
    return true;
  }

  console.log(quotaText);
  return true;
}
