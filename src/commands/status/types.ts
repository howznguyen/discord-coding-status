'use strict';

import type { SetupToolRow, SetupSystemRow } from '../setup/types';

export interface QuotaSummaryItem {
  tool: string;
  status: string;
  detail: string;
}

export interface ActivitySummaryItem {
  tool: string;
  sessionId: string;
  project?: string;
  activity?: string;
  model?: string;
  effort?: string;
  status: string;
  timeAgo: string;
}

export interface StatusSummaryContext {
  appTitle: string;
  version: string;
  author: string;
  system: SetupSystemRow[];
  tools: SetupToolRow[];
  quotas?: QuotaSummaryItem[];
  activities: ActivitySummaryItem[];
}
