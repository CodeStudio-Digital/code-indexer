/** Shared types for the App Settings panel (mirrors the GET /api/admin/settings shape). */
export type SettingType = 'string' | 'bool' | 'int' | 'float' | 'url' | 'secret';
export type SettingCategory =
  | 'llm'
  | 'mcp'
  | 'indexing'
  | 'sandbox'
  | 'agent'
  | 'company'
  | 'notifications'
  | 'memory'
  | 'debug';
export type Source = 'db' | 'env' | 'default' | 'unset';

export interface SettingItem {
  key: string;
  label: string;
  description: string;
  type: SettingType;
  category: SettingCategory;
  advanced: boolean;
  restartNeeded: boolean;
  validationError?: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  default: string | null;
  source: Source;
  updatedAt: string | null;
  /** Non-secret current value. Null for secrets. */
  value: string | null;
  /** For secrets: whether anything is stored (without revealing it). */
  hasValue: boolean;
}

export interface CategoryDef {
  id: SettingCategory;
  label: string;
}

export interface SettingsResponse {
  items: SettingItem[];
  categories: readonly CategoryDef[];
  restartRequired?: boolean;
}

/** Sparse map: only keys the user touched land here. */
export type EditMap = Record<string, string | null>;
