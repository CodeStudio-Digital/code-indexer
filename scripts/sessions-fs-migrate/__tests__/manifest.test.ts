import {
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
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

function scanMigrationSchema(sources: readonly string[]): SchemaTable[] {
  const schema = new Map<string, Set<string>>();
  const add = (table: string, column: string): void => {
    const columns = schema.get(table) ?? new Set<string>();
    columns.add(column);
    schema.set(table, columns);
  };
  const applySql = (sql: string): void => {
    const events: Array<{ offset: number; apply: () => void }> = [];
    const create = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi;
    for (const match of sql.matchAll(create)) events.push({ offset: match.index!, apply: () => {
      for (const column of match[2].matchAll(/^\s*([a-z][a-z0-9_]*)\s+(?:INTEGER|TEXT|BLOB|REAL|NUMERIC)\b/gim)) add(match[1], column[1]);
    } });
    const alter = /ALTER\s+TABLE\s+([a-z][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z][a-z0-9_]*)/gi;
    for (const match of sql.matchAll(alter)) events.push({ offset: match.index!, apply: () => add(match[1], match[2]) });
    const drop = /DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+([a-z][a-z0-9_]*)\s*;/gi;
    for (const match of sql.matchAll(drop)) events.push({ offset: match.index!, apply: () => { schema.delete(match[1]); } });
    const rename = /ALTER\s+TABLE\s+([a-z][a-z0-9_]*)\s+RENAME\s+TO\s+([a-z][a-z0-9_]*)/gi;
    for (const match of sql.matchAll(rename)) events.push({ offset: match.index!, apply: () => {
      const columns = schema.get(match[1]);
      if (columns) { schema.set(match[2], columns); schema.delete(match[1]); }
    } });
    for (const event of events.sort((a, b) => a.offset - b.offset)) event.apply();
  };
  for (const source of sources) {
    const tree = ts.createSourceFile('migration.ts', source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const argument = node.arguments[0];
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'exec' && argument) {
          if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) applySql(argument.text);
          else if (ts.isTemplateExpression(argument)) applySql(argument.head.text + argument.templateSpans.map((span) => '?'+span.literal.text).join(''));
        }
        if (ts.isIdentifier(node.expression) && /^(?:addColumnIfMissing|addColumn)$/.test(node.expression.text)) {
          const table = node.arguments[1], column = node.arguments[2];
          if (table && column && ts.isStringLiteral(table) && ts.isStringLiteral(column)) add(table.text, column.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return [...schema]
    .filter(([name]) => !/(?:_new|_v\d+)$/.test(name))
    .map(([name, columns]) => ({ name, columns: [...columns] }));
}

function scanMigrationSourceSchema(): SchemaTable[] {
  const directory = resolve('packages/store/src/migrations');
  const sources = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readFileSync(join(directory, entry.name), 'utf8'));
  return scanMigrationSchema(sources);
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

  it('follows retirement and table rebuilds without hiding recreated session schema', () => {
    const create = (name: string) => 'db.exec(' + JSON.stringify('CREATE TABLE '+name+' (\n  id INTEGER,\n  session_id TEXT\n);') + ');';
    const retired = create('retired_cache') + 'db.exec("DROP TABLE retired_cache;");';
    expect(scanMigrationSchema([retired])).toEqual([]);
    const recreated = scanMigrationSchema([retired, create('retired_cache')]);
    expect(findUnclassifiedSessionSchema(recreated)).toEqual(['unclassified session schema: retired_cache (session_id)']);
    const rebuilt = scanMigrationSchema([
      create('rebuilt_cache'), create('rebuilt_cache_new')
        + 'db.exec("DROP TABLE rebuilt_cache; ALTER TABLE rebuilt_cache_new RENAME TO rebuilt_cache;");',
    ]);
    expect(findUnclassifiedSessionSchema(rebuilt)).toEqual(['unclassified session schema: rebuilt_cache (session_id)']);
    expect(scanMigrationSchema([create('commented_cache') + '// DROP TABLE commented_cache;'])).toHaveLength(1);
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
