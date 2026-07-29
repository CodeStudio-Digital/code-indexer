import {
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELETE_ROW_DISPOSITIONS,
  DROP_TABLES,
  LEGACY_ORPHAN_CLEANUP_DISPOSITIONS,
  POST_CUT_ROW_GUARDS,
  REDUNDANT_PROJECTION_TABLES,
  SQLITE_ESSENTIAL_EXPLICIT_KEEP,
  TABLE_DISPOSITIONS,
  assertDispositionManifest,
  findForbiddenSessionSchema,
  findUnclassifiedSessionSchema,
  type SchemaTable,
} from '../manifest.js';

function scanMigrationSourceSchema(): SchemaTable[] {
  const directory = resolve('packages/store/src/migrations');
  const schema = new Map<string, Set<string>>();
  const add = (table: string, column: string): void => {
    const columns = schema.get(table) ?? new Set<string>();
    columns.add(column);
    schema.set(table, columns);
  };

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(join(directory, entry.name), 'utf8');
    const create = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi;
    for (const match of source.matchAll(create)) {
      const table = match[1];
      const columns = match[2].matchAll(
        /^\s*([a-z][a-z0-9_]*)\s+(?:INTEGER|TEXT|BLOB|REAL|NUMERIC)\b/gim,
      );
      for (const column of columns) add(table, column[1]);
    }
    const helper = /(?:addColumnIfMissing|addColumn)\(\s*db\s*,\s*['"]([a-z][a-z0-9_]*)['"]\s*,\s*['"]([a-z][a-z0-9_]*)['"]/gi;
    for (const match of source.matchAll(helper)) add(match[1], match[2]);
    const alter = /ALTER\s+TABLE\s+([a-z][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z][a-z0-9_]*)/gi;
    for (const match of source.matchAll(alter)) add(match[1], match[2]);
  }
  return [...schema]
    .filter(([name]) => !/(?:_new|_v\d+)$/.test(name))
    .map(([name, columns]) => ({ name, columns: [...columns] }));
}

describe('explicit SQLite disposition manifest', () => {
  it('is internally consistent and keeps the global capability catalog', () => {
    expect(() => assertDispositionManifest()).not.toThrow();
    const keep = new Set<string>(SQLITE_ESSENTIAL_EXPLICIT_KEEP);
    expect(DROP_TABLES.filter((table) => keep.has(table))).toEqual([]);
    expect(keep.has('capability_descriptors')).toBe(true);
  });

  it('classifies session provider bindings as rows, not as a dropped catalog', () => {
    expect(DELETE_ROW_DISPOSITIONS.find(
      (item) => item.table === 'pipeline_provider_bindings',
    )?.whereSql).toBe("scope_type = 'session'");
    expect(DROP_TABLES).not.toContain('pipeline_provider_bindings');
    expect(POST_CUT_ROW_GUARDS.map((guard) => guard.table)).toEqual([
      'pipeline_provider_bindings',
      'company_drive_files',
    ]);
  });

  it('keeps project investigations and declares every accepted orphan family explicitly', () => {
    const investigations = DELETE_ROW_DISPOSITIONS.find(
      (item) => item.table === 'coder_investigations',
    );
    expect(DROP_TABLES).not.toContain('coder_investigations');
    expect(investigations?.whereSql).toBe('project_id IS NULL AND session_id IS NOT NULL');
    expect(investigations?.dropColumns).toEqual(['session_id']);
    expect(SQLITE_ESSENTIAL_EXPLICIT_KEEP).toContain('coder_investigations');
    expect(LEGACY_ORPHAN_CLEANUP_DISPOSITIONS.map((item) => item.table)).toEqual(
      expect.arrayContaining([
        'coder_turn_telemetry',
        'coder_subagent_runs',
        'coder_subagent_tool_calls',
        'session_file_baselines',
        'policy_decisions',
      ]),
    );
  });

  it('declares the FTS projection and every shadow explicitly', () => {
    expect(REDUNDANT_PROJECTION_TABLES).toEqual([
      'coder_session_chapters_fts',
      'coder_session_chapters_fts_config',
      'coder_session_chapters_fts_data',
      'coder_session_chapters_fts_docsize',
      'coder_session_chapters_fts_idx',
    ]);
    for (const table of REDUNDANT_PROJECTION_TABLES) expect(DROP_TABLES).toContain(table);
  });

  it('covers session locator columns found in the real migration sources', () => {
    const schema = scanMigrationSourceSchema();
    expect(schema.length).toBeGreaterThan(50);
    expect(findUnclassifiedSessionSchema(schema)).toEqual([]);
  });

  it('fails closed for a newly introduced unclassified session table', () => {
    expect(findUnclassifiedSessionSchema([
      { name: 'new_operational_cache', columns: ['id', 'session_id'] },
    ])).toEqual([
      'unclassified session schema: new_operational_cache (session_id)',
    ]);
  });

  it('rejects forbidden tables and mixed columns in a clean schema', () => {
    const violations = findForbiddenSessionSchema([
      { name: 'coder_sessions', columns: ['id'] },
      { name: 'agent_memory_events', columns: ['id', 'session_id'] },
      { name: 'capability_descriptors', columns: ['id'] },
    ]);
    expect(violations).toEqual([
      'forbidden session table: coder_sessions',
      'forbidden session column: agent_memory_events.session_id',
    ]);
    expect(TABLE_DISPOSITIONS.length).toBeGreaterThan(50);
  });
});
