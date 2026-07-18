/**
 * Shared types + category list for the app-settings catalog. Split out of
 * `app-settings-catalog.ts` so each category module stays small (the catalog
 * grew past the LOC cap). The barrel re-exports everything from here, so the
 * public import path (`@mcp/store/.../app-settings-catalog.js`) is unchanged.
 */
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

export interface SettingDef {
  /** The env-var name as referenced in `process.env`. */
  key: string;
  /** Short label for the input row. */
  label: string;
  /** One-liner help text rendered as muted-fg below the label. */
  description: string;
  type: SettingType;
  category: SettingCategory;
  /** Fallback used when neither the DB nor process.env has a value. */
  default?: string;
  /** Grouped behind the "Advanced" toggle when true. */
  advanced?: boolean;
  /** Surfaces a "restart needed" pill — the env isn't hot-applied. */
  restartNeeded?: boolean;
  /** Min/max for int/float inputs — surface clamp range hints. */
  min?: number;
  max?: number;
  /** Enum-style string. Renders a Select instead of a free Input. */
  options?: readonly string[];
}

/** All categories, in display order. */
export const SETTING_CATEGORIES: readonly { id: SettingCategory; label: string }[] = [
  { id: 'llm', label: 'Model overrides' },
  { id: 'mcp', label: 'MCP & workers' },
  { id: 'indexing', label: 'Indexing & search' },
  { id: 'sandbox', label: 'Sandbox & containers' },
  { id: 'agent', label: 'Agent behaviour' },
  { id: 'company', label: 'Company / multi-agent' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'memory', label: 'Memory & consolidation' },
  { id: 'debug', label: 'Debug & logging' },
];
