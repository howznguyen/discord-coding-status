'use strict';

export type ToolFamily = string;

export interface ToolDefinition {
  key: string;
  details: string;
  state: string;
  family?: ToolFamily;
}

export interface ProcessInfo {
  pid: number;
  line: string;
  raw: string;
  executablePath?: string | null;
  commandLine?: string | null;
  /** Cumulative CPU time of the process in milliseconds (when available). */
  cpuMs?: number;
}

/**
 * Where the evidence for an active session came from. Hook reports are
 * authoritative: they carry the real session id, model, and activity, whereas
 * process detection can only observe that a binary is running.
 */
export type ToolSource = 'hook' | 'process';

export interface ActiveTool extends ToolDefinition {
  source?: ToolSource;
  providerId?: string;
  processInfo?: ProcessInfo;
  cwd?: string | null;
  sessionId?: string | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  status?: string | null;
  activity?: string | null;
  model?: string | null;
  effort?: string | null;
  contextText?: string | null;
  projectName?: string | null;
  packageName?: string | null;
  claudeQuotaEligible?: boolean | null;
  title?: string | null;
  sessionCount?: number | null;
}
