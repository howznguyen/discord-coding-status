'use strict';

export interface DaemonRefreshResult {
  status: 'restarted' | 'not-installed' | 'unsupported' | 'failed' | 'skipped';
  error?: string;
}
