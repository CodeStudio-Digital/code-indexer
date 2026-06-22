/**
 * Built-in micro-strings the UI builders render (loading, "no rows", "Create",
 * …). Defaults are English; a plugin that localizes calls `configureKitLabels`
 * once at boot with its own translations so the shared builders stay i18n-aware
 * without the SDK shipping any plugin's catalog.
 */
export interface KitLabels {
  loading: string;
  noRows: string;
  noMatches: string;
  actions: string;
  create: string;
  filter: string;
  confirm: string;
  cancel: string;
  done: string;
  streamStopped: string;
  streamDone: string;
  toolFailed: string;
  badJson: string;
}

const DEFAULTS: KitLabels = {
  loading: 'Loading…',
  noRows: 'Nothing here',
  noMatches: 'No matches',
  actions: 'Actions',
  create: 'Create',
  filter: 'Filter…',
  confirm: 'Confirm',
  cancel: 'Cancel',
  done: 'Done',
  streamStopped: 'Stopped',
  streamDone: 'Done',
  toolFailed: 'Tool failed',
  badJson: 'Invalid JSON',
};

let current: KitLabels = { ...DEFAULTS };

export function configureKitLabels(partial: Partial<KitLabels>): void {
  current = { ...current, ...partial };
}

export function kitLabel(key: keyof KitLabels): string {
  return current[key];
}
