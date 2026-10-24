import type { AgentMemoryScope } from '@mcp/shared/types.js';
/** Normalize a free-form title into a stable kebab-case slug (3-6 words). */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const words = base.split('-').filter(Boolean).slice(0, 6);
  return words.join('-') || 'memory';
}

export function normalizeScopeProject(scope: AgentMemoryScope, projectId: number): number {
  // user-scope memory always lives on the reserved project 0 (mirrors snapshots
  // user-memory). local/project keep their real project id.
  return scope === 'user' ? 0 : projectId;
}

/** Chunk size for the IN(...) hydration below; keeps the statement cache small. */
export const BATCH_IDS = 100;

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
