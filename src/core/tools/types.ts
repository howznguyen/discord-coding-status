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
}

export interface ActiveTool extends ToolDefinition {
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
}
