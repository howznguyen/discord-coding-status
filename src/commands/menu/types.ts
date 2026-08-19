'use strict';

export interface MenuItem {
  /** Stable id used by the runner to decide what to execute. */
  id: string;
  label: string;
  hint: string;
  /** Argv passed back to the CLI. Omit for items the runner handles itself. */
  argv?: readonly string[];
  section: string;
  /** Long-running items hand the terminal over instead of returning to the menu. */
  takesOver?: boolean;
}

export interface MenuRunResult {
  /** Exit code of the spawned command, or null when it was terminated. */
  code: number | null;
}
