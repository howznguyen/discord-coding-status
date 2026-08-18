'use strict';

export interface SetupHookSummary {
  installed: number;
  file?: string;
  removed?: number;
}

export interface SetupToolRow {
  name: string;
  detection: string;
  integration: string;
}

export interface SetupSystemRow {
  name: string;
  status: string;
  target: string;
}

export interface SetupSummaryContext {
  appTitle: string;
  version: string;
  author: string;
  tools: SetupToolRow[];
  system: SetupSystemRow[];
  notes?: string[];
}
