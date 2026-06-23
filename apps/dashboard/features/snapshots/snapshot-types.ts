/**
 * Shared types + constants for the context-snapshots feature. Lives at
 * the feature root so the master container, the sidebar list and the
 * detail pane all import from a single place — no drift, no duplicate
 * category lists.
 */

export interface Snapshot {
  id: number;
  title: string;
  category: string;
  content: string;
  tags: string;
  created_by: string;
  created_at: string;
  // Mem C metadata (migration 114) — the API already returns these
  // (SELECT *); optional so older payload shapes keep working.
  /** 'manual' | 'agent' | 'session' | 'compaction' | 'index' */
  source?: string;
  /** 0..1 — retrieval ranking weight; floors set by the distiller. */
  importance?: number;
  /** Times retrieval injected this memory into an agent prompt. */
  access_count?: number;
  last_accessed_at?: string | null;
}

export interface SnapshotVersion {
  id: number;
  snapshot_id: number;
  version: number;
  title: string;
  category: string;
  content: string;
  tags: string;
  updated_at: string;
  updated_by: string;
}

export const CATEGORIES = [
  'architecture',
  'decision',
  'pattern',
  'convention',
  'todo',
  'note',
  'gotcha',
  'procedure',
] as const;

export type SnapshotCategory = (typeof CATEGORIES)[number];

/**
 * Tailwind classes for the category pill. The two-tone palette mirrors
 * the legacy editor (matches the user's existing visual mental model).
 * Dark mode variants kept identical to legacy.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  architecture: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  decision: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200',
  pattern: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  convention: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200',
  todo: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  note: 'bg-gray-100 text-gray-800 dark:bg-gray-700/60 dark:text-gray-200',
  gotcha: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
  procedure: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200',
};

/** Parse the JSON-stringified tags column, swallowing malformed payloads. */
export function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
