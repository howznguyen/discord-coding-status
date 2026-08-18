'use strict';

import { createColors } from 'picocolors';
import type { HookSessionState } from '../../core/hooks/types';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface StateCommandContext {
  stateFile: string;
  getState: () => unknown;
  clearState: (sessionId?: string) => void;
  upsertState: (session: HookSessionState) => void;
  getCodexSession: (args: Record<string, string | boolean>) => HookSessionState;
  getClaudeSession: (args: Record<string, string | boolean>) => HookSessionState;
  getGrokSession: (args: Record<string, string | boolean>) => HookSessionState;
  getGenericSession: (args: Record<string, string | boolean>) => HookSessionState | null;
  isGrokAncestry: () => boolean;
}

export function runStateCommand(
  command: string,
  args: Record<string, string | boolean>,
  context: StateCommandContext
): boolean {
  if (!['hook', 'codex-hook', 'claude-hook', 'grok-hook', 'clear', 'state'].includes(command)) {
    return false;
  }

  if (command === 'state') {
    console.log(JSON.stringify(context.getState(), null, 2));
    return true;
  }

  if (command === 'clear') {
    const sessionId = (args['session-id'] || args.session_id || args['sessionId']) as string | undefined;
    context.clearState(sessionId || undefined);
    console.log(pc.green(`✔ ${sessionId ? `Cleared session ${sessionId}` : 'Cleared all active sessions'}`));
    return true;
  }

  if (command === 'codex-hook') {
    const session = context.getCodexSession(args);
    context.upsertState(session);
    return true;
  }

  if (command === 'claude-hook') {
    if (context.isGrokAncestry()) {
      const session = context.getGrokSession(args);
      context.upsertState(session);
      return true;
    }
    const session = context.getClaudeSession(args);
    context.upsertState(session);
    return true;
  }

  if (command === 'grok-hook') {
    const session = context.getGrokSession(args);
    context.upsertState(session);
    return true;
  }

  const session = context.getGenericSession(args);
  if (!session) {
    console.error(pc.red('✖ Missing valid hook state. Required: --tool <name>. Recommended: --session-id <id> --cwd "$PWD".'));
    process.exitCode = 1;
    return true;
  }

  context.upsertState(session);
  console.log(JSON.stringify({ ok: true, stateFile: context.stateFile, session }, null, 2));
  return true;
}
