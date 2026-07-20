'use strict';

export interface PackageInfo {
  root: string;
  name: string | null;
}

export interface PresenceMetadata {
  projectName: string | null;
  packageName: string | null;
  branchName: string | null;
  usageText: string | null;
}

export interface RichStateParts {
  planText: string | null;
  limitsText: string | null;
}

export interface PresencePayload {
  details?: string;
  state?: string;
  startTimestamp: Date;
  instance: false;
  largeImageKey?: string;
  smallImageKey?: string;
}
