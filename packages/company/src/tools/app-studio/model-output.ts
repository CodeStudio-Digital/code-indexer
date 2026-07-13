import { renderStructuredMarkdown, structuredResult } from '@mcp/code-agent/core/model-output.js';

export const PAGE_PROPERTIES: Record<string, Record<string, unknown>> = {
  ids: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional stable IDs/names to return. Applied before pagination.',
  },
  offset: { type: 'number', description: 'Zero-based item offset. Default: 0.' },
  limit: { type: 'number', description: 'Maximum items. Default: 25; maximum: 100.' },
};

export interface PageResult<T> {
  items: T[];
  page: { offset: number; returned: number; total: number; more: boolean; next_offset: number | null };
}

export function pageArgs(args: Record<string, unknown>): { offset: number; limit: number; ids: Set<string> } {
  const offset = typeof args.offset === 'number' && Number.isFinite(args.offset)
    ? Math.max(0, Math.floor(args.offset))
    : 0;
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(100, Math.floor(args.limit)))
    : 25;
  const ids = new Set(Array.isArray(args.ids) ? args.ids.map(String).filter(Boolean) : []);
  return { offset, limit, ids };
}

export function viewArg<const T extends string>(
  args: Record<string, unknown>,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof args.view === 'string' && (allowed as readonly string[]).includes(args.view)
    ? args.view as T
    : fallback;
}

export function pageItems<T>(
  input: readonly T[],
  args: Record<string, unknown>,
  identity: (item: T) => string,
): PageResult<T> {
  const { offset, limit, ids } = pageArgs(args);
  const filtered = ids.size > 0 ? input.filter((item) => ids.has(identity(item))) : [...input];
  const items = filtered.slice(offset, offset + limit);
  const end = offset + items.length;
  return {
    items,
    page: {
      offset,
      returned: items.length,
      total: filtered.length,
      more: end < filtered.length,
      next_offset: end < filtered.length ? end : null,
    },
  };
}

export function compactAudit<T extends { ok?: boolean; issues: readonly unknown[] }>(audit: T | null | undefined): {
  ok: boolean;
  issue_count: number;
  top_issues: unknown[];
} | null {
  if (!audit) return null;
  const ok = typeof audit.ok === 'boolean'
    ? audit.ok
    : !audit.issues.some((issue) => (
      issue != null
      && typeof issue === 'object'
      && 'severity' in issue
      && (issue as { severity?: unknown }).severity === 'error'
    ));
  return { ok, issue_count: audit.issues.length, top_issues: audit.issues.slice(0, 5) };
}

export function appResult(title: string, data: unknown) {
  return structuredResult(data, renderStructuredMarkdown(data, title));
}
