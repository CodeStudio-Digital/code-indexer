/**
 * PURE scope resolution for the `db_*` tools — no stores, no ctx, no I/O.
 *
 * Single session → the project's connections, addressed by their label.
 * Company session → connections of every linked project, addressed as
 * `<projectSlug>:<label>` so labels can repeat across projects.
 *
 * Error messages are didactic on purpose (same tone as the retired
 * @mcp/company database-tools): they tell the model exactly how to recover.
 */

/** The row subset scope logic needs (structural slice of DbConnection). */
export interface ConnLite {
  id: number;
  project_id: number;
  label: string;
  engine: string;
  is_read_only: number;
}

export interface ScopedConn<C extends ConnLite = ConnLite> {
  /** Unique name the model addresses: `<label>` or `<projectSlug>:<label>`. */
  name: string;
  conn: C;
}

export interface ScopeInput<C extends ConnLite = ConnLite> {
  /** Single-session project id (label-only names). */
  projectId?: number | null;
  /** Company session id — when set, names are prefixed with the project slug. */
  companySessionId?: string | null;
  /** Pre-fetched rows, each tagged with its project's display slug (company). */
  connections: ReadonlyArray<{ conn: C; projectSlug?: string | null }>;
}

/** Normalize a slug for the `<slug>:<label>` addressing (no ':' or spaces). */
export function sanitizeSlug(raw: string | null | undefined, projectId: number): string {
  const s = (raw ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || `project-${projectId}`;
}

/** Engine → capability category, WITHOUT connecting (db_list must not connect). */
export function engineKind(engine: string): 'relational' | 'document' | 'keyvalue' {
  if (engine === 'mongodb') return 'document';
  if (engine === 'redis') return 'keyvalue';
  return 'relational';
}

/**
 * Build the addressable scope. Names are made unique: an exact duplicate gets
 * a `#<id>` suffix so every row stays reachable (and error lists stay honest).
 */
export function resolveDbScope<C extends ConnLite>(input: ScopeInput<C>): ScopedConn<C>[] {
  const company = input.companySessionId != null;
  const seen = new Set<string>();
  const out: ScopedConn<C>[] = [];
  for (const { conn, projectSlug } of input.connections) {
    const base = company
      ? `${sanitizeSlug(projectSlug, conn.project_id)}:${conn.label}`
      : conn.label;
    const name = seen.has(base) ? `${base}#${conn.id}` : base;
    seen.add(name);
    out.push({ name, conn });
  }
  return out;
}

export type PickResult<C extends ConnLite> =
  | { ok: true; value: ScopedConn<C> }
  | { ok: false; error: string };

/**
 * Pick one connection from the scope:
 *  - 0 registered   → didactic error pointing at the Databases tab;
 *  - 1 registered   → default when no name given;
 *  - >1, no name    → error listing the valid names;
 *  - unknown name   → error listing the known names.
 * A bare label also matches in company scope when it is unambiguous.
 */
export function pickConnection<C extends ConnLite>(
  scope: ReadonlyArray<ScopedConn<C>>,
  nameArg?: unknown,
): PickResult<C> {
  if (scope.length === 0) {
    return {
      ok: false,
      error:
        'No database connections registered. Ask the user to add one in the ' +
        "project's Databases tab.",
    };
  }
  const name = typeof nameArg === 'string' ? nameArg.trim() : '';
  if (!name) {
    if (scope.length === 1) return { ok: true, value: scope[0] };
    return {
      ok: false,
      error:
        `Multiple connections available (${scope.map((s) => s.name).join(', ')}). ` +
        'Pass the `connection` arg — call db_list if unsure which one to use.',
    };
  }
  const exact = scope.find((s) => s.name === name);
  if (exact) return { ok: true, value: exact };
  // Company convenience: a bare label resolves when only one project has it.
  const byLabel = scope.filter((s) => s.conn.label === name);
  if (byLabel.length === 1) return { ok: true, value: byLabel[0] };
  return {
    ok: false,
    error:
      `No connection named '${name}'. Known connections: ` +
      scope.map((s) => s.name).join(', '),
  };
}
