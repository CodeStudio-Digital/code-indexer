
export type EnvSource = 'user' | 'imported' | 'auto' | 'agent';

/** Sub-family of an `auto` row, derived from the key prefix in EnvTab. */
export type EnvAutoKind = 'database' | 'sandbox' | 'auto';

export interface EnvRow {
  key: string;
  value: string;
  is_secret: boolean;
  masked: boolean;
  source?: EnvSource;
  /** CSV of service ids, or null/undefined = every service (D1). */
  service_scope?: string | null;
  updated_at: string;
}
