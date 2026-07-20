'use strict';

export type CodexQuotaSource = 'off' | 'rpc' | 'oauth' | 'auto';
export type CodexQuotaSnapshotSource = 'codex-rpc' | 'codex-oauth';

export interface CodexQuotaWindow {
  usedPercent: number;
  windowMinutes: number | null;
}

export interface CodexQuotaSnapshot {
  source: CodexQuotaSnapshotSource;
  planText: string | null;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
  creditsRemaining: number | null;
}

export interface CodexOAuthCredentials {
  accessToken: string | null;
  refreshToken: string | null;
  accountId: string | null;
}

export interface PendingJsonRpcRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}
