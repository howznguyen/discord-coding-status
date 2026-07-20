'use strict';

export interface HookSessionState {
  tool: string;
  surface: string;
  status: string;
  session_id: string;
  cwd: string;
  updated_at: number;
  started_at?: number;
  project?: string;
  package?: string;
  title?: string;
  activity?: string;
  model?: string;
  effort?: string;
  context?: string;
  claude_quota_eligible?: boolean;
}

export interface HookStateFile {
  version: 1;
  sessions: Record<string, HookSessionState>;
}
