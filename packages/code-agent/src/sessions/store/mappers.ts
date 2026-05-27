import type { CoderSession } from '@mcp/code-agent/sessions/types.js';

export type SessionRow = Omit<CoderSession, 'is_archived' | 'is_favorite' | 'unrestricted_tool_output'> & {
  is_archived: number;
  is_favorite: number;
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
    unrestricted_tool_output: unrestricted == null ? null : !!unrestricted,
  } as CoderSession;
}
