'use strict';

/**
 * Outcome of asking the platform to restart the managed daemon.
 *
 * Lives in `core` because both the adapter that performs the restart and the
 * command layer that reports it need the shape, and `commands` may not import
 * from `adapters`.
 */
export interface DaemonRefreshResult {
  status: 'restarted' | 'not-installed' | 'unsupported' | 'failed' | 'skipped';
  error?: string;
}
