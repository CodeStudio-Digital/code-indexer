import type {
  BundlePlan,
  SqliteDatabase,
} from './model.js';
import {
  tableColumns,
  tableExists,
} from './db.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DesignSessionIdRemap = ReadonlyMap<string, string>;

interface BuilderJsonRewrite {
  value: string | null;
  changed: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function legacyIdKey(value: number | string): string {
  if (typeof value === 'number') return String(value);
  return /^\d+$/.test(value) ? String(Number(value)) : value;
}

/**
 * Build the only supported Design link bridge for the irreversible cut:
 * legacy SQLite integer id -> filesystem session UUID. The map is transient
 * and is deleted with the migration staging directory after the final smoke.
 */
export function buildDesignSessionIdRemap(
  plans: readonly BundlePlan[],
): Map<string, string> {
  const output = new Map<string, string>();
  for (const plan of plans) {
    if (plan.identity.kind !== 'design') continue;
    if (!UUID_RE.test(plan.uuid)) {
      throw new Error(`Design migration plan has a non-UUID id: ${plan.uuid}`);
    }
    output.set(legacyIdKey(plan.identity.id), plan.uuid.toLowerCase());
  }
  return output;
}

export function projectBuilderJsonWithDesignUuid(
  raw: unknown,
  remap: DesignSessionIdRemap,
  label: string,
): BuilderJsonRewrite {
  if (raw == null) return { value: null, changed: false };
  if (typeof raw !== 'string') {
    throw new Error(`${label} builder_json is not text`);
  }
  if (raw.trim().length === 0) return { value: raw, changed: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (/"designSystem"\s*:/.test(raw)) {
      throw new Error(
        `${label} has invalid builder_json containing a Design System link`,
        { cause: error },
      );
    }
    return { value: raw, changed: false };
  }
  if (!isObject(parsed) || !Object.hasOwn(parsed, 'designSystem')) {
    return { value: raw, changed: false };
  }
  const designSystem = parsed.designSystem;
  if (designSystem == null) return { value: raw, changed: false };
  if (!isObject(designSystem)) {
    throw new Error(`${label} builder_json.designSystem is not an object`);
  }
  const sessionId = designSystem.sessionId;
  if (sessionId == null) return { value: raw, changed: false };
  if (typeof sessionId === 'string' && UUID_RE.test(sessionId)) {
    return { value: raw, changed: false };
  }
  if (
    !(
      (typeof sessionId === 'number' && Number.isSafeInteger(sessionId) && sessionId > 0)
      || (typeof sessionId === 'string' && /^\d+$/.test(sessionId))
    )
  ) {
    throw new Error(
      `${label} builder_json.designSystem.sessionId is neither a legacy integer nor UUID`,
    );
  }
  const replacement = remap.get(legacyIdKey(sessionId));
  if (!replacement) {
    throw new Error(
      `${label} references missing legacy Design System session ${String(sessionId)}`,
    );
  }
  designSystem.sessionId = replacement;
  return {
    value: JSON.stringify(parsed),
    changed: true,
  };
}

function projectRows(
  db: SqliteDatabase,
): Array<{ id: number; builder_json: unknown }> {
  if (
    !tableExists(db, 'projects')
    || !tableColumns(db, 'projects').includes('builder_json')
  ) {
    return [];
  }
  return db.prepare(
    `SELECT id, builder_json FROM projects ORDER BY id`,
  ).all() as Array<{ id: number; builder_json: unknown }>;
}

export function validateProjectDesignSystemLinks(
  db: SqliteDatabase,
  remap: DesignSessionIdRemap,
): void {
  for (const row of projectRows(db)) {
    projectBuilderJsonWithDesignUuid(
      row.builder_json,
      remap,
      `Project ${row.id}`,
    );
  }
}

export function rewriteProjectDesignSystemLinks(
  db: SqliteDatabase,
  remap: DesignSessionIdRemap,
): number {
  const rows = projectRows(db);
  if (rows.length === 0) return 0;
  const update = db.prepare(
    `UPDATE projects SET builder_json = ? WHERE id = ?`,
  );
  let changed = 0;
  for (const row of rows) {
    const next = projectBuilderJsonWithDesignUuid(
      row.builder_json,
      remap,
      `Project ${row.id}`,
    );
    if (!next.changed) continue;
    update.run(next.value, row.id);
    changed += 1;
  }
  return changed;
}

export function assertProjectDesignSystemLinksUseUuid(
  db: SqliteDatabase,
): void {
  for (const row of projectRows(db)) {
    const value = projectBuilderJsonWithDesignUuid(
      row.builder_json,
      new Map(),
      `Project ${row.id}`,
    );
    void value;
  }
}
