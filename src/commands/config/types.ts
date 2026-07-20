'use strict';

export type DetailLevel = 'safe' | 'project' | 'full';
export type ActivityStyle = 'fun' | 'normal' | 'technical' | 'minimal';

export interface ConfigEditorField {
  key: string;
  label: string;
  defaultValue: string;
  choices?: string[];
}

export interface DisplayLayout {
  activity: boolean;
  project: boolean;
  model: boolean;
  quota: boolean;
  context: boolean;
  package: boolean;
}

export interface ConfigPreviewSamples {
  activity: string;
  project: string;
  model: string;
  quota: string;
  context: string;
  package: string;
}

export interface ConfigTuiItem {
  key: string;
  label: string;
  section: 'Top line' | 'Bottom line' | 'Behavior';
  kind: 'toggle' | 'choice';
  choices?: string[];
}

export interface ConfigTuiResult {
  action: 'save' | 'advanced' | 'cancel';
  entries: Record<string, string>;
}
