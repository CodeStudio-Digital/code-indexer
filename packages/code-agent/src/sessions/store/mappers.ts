import type { CoderSession } from '@mcp/code-agent/sessions/types.js';

export type SessionRow = Omit<CoderSession, 'is_archived' | 'is_favorite' | 'is_global' | 'unrestricted_tool_output'> & {
  is_archived: number;
  is_favorite: number;
  /** Migration 152 — SQLite INTEGER 0|1, coerced to boolean at map time. */
  is_global: number;
  /** SQLite stores INTEGER 0|1|NULL — coerced to boolean|null at map time. */
  unrestricted_tool_output: number | null;
};

export function mapSessionRow(row: SessionRow | undefined | null): CoderSession | null {
  if (!row) return null;
  const unrestricted = row.unrestricted_tool_output;
  return {
    ...row,
    is_archived: !!row.is_archived,
    is_favorite: !!row.is_favorite,
    // `is_global` is absent on rows from a pre-152 DB read mid-upgrade; `!!undefined`
    // is false, which is the correct default (non-global).
    is_global: !!row.is_global,
    unrestricted_tool_output: unrestricted == null ? null : !!unrestricted,
  } as CoderSession;
}
