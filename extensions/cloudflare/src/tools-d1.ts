/**
 * D1 database management: databases, schema/table exploration, row CRUD, SQL,
 * export/import and time-travel operations.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import {
  asRecord,
  cfAcct,
  cfAcctPaged,
  d1Query,
  fail,
  list,
  ok,
  optNumber,
  optString,
  parseJson,
  quoteIdent,
  reqString,
  resolveD1Database,
} from './lib.js';

interface D1Database {
  uuid: string;
  name: string;
  created_at?: string;
  version?: string;
}

function cols(rows: Array<Record<string, unknown>>): string[] {
  return rows.length ? Object.keys(rows[0]) : [];
}

function rowData(args: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(parseJson(args.data ?? args.values, {}));
  if (!Object.keys(data).length) throw new Error('data is required');
  return data;
}

export const d1Tools = [
  contributeTool({
    name: 'cf_d1_list',
    description:
      'List D1 databases in the selected account (name + uuid). Every other cf_d1_* tool ' +
      'accepts either the name or the uuid as its `database` arg.',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const dbs = await cfAcctPaged<D1Database>(ctx, '/d1/database');
      return list(dbs, (db) => `- ${db.name} (${db.uuid})`, 'No D1 databases.');
    },
  }),
  contributeTool({
    name: 'cf_d1_get',
    description: 'Get D1 database details by name or UUID',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { database: { type: 'string' } }, required: ['database'] },
    handler: async (a, ctx) => {
      const db = await resolveD1Database(ctx, reqString(a, 'database'));
      const full = await cfAcct<D1Database>(ctx, `/d1/database/${db.uuid}`);
      return ok(`D1 database ${full.name} (${full.uuid})`, { details: full });
    },
  }),
  contributeTool({
    name: 'cf_d1_create',
    description: 'Create a D1 database',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, primary_location_hint: { type: 'string' } },
      required: ['name'],
    },
    handler: async (a, ctx) => {
      const body: Record<string, unknown> = { name: reqString(a, 'name') };
      const hint = optString(a, 'primary_location_hint');
      if (hint) body.primary_location_hint = hint;
      const db = await cfAcct<D1Database>(ctx, '/d1/database', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return ok(`Created D1 database ${db.name}.`, { details: db });
    },
  }),
  contributeTool({
    name: 'cf_d1_update',
    description: 'Update D1 database metadata by name or UUID',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { database: { type: 'string' }, name: { type: 'string' } },
      required: ['database'],
    },
    handler: async (a, ctx) => {
      const db = await resolveD1Database(ctx, reqString(a, 'database'));
      const name = optString(a, 'name');
      if (!name) return fail('name is required');
      const updated = await cfAcct<D1Database>(ctx, `/d1/database/${db.uuid}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      return ok(`Updated D1 database ${updated.name}.`, { details: updated });
    },
  }),
  contributeTool({
    name: 'cf_d1_delete',
    description:
      'Permanently delete an entire D1 database by name or UUID — destructive and irreversible; ' +
      'always confirm with the user and restate which database will be dropped.',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { database: { type: 'string' } }, required: ['database'] },
    handler: async (a, ctx) => {
      const db = await resolveD1Database(ctx, reqString(a, 'database'));
      await cfAcct(ctx, `/d1/database/${db.uuid}`, { method: 'DELETE' });
      return ok(`Deleted D1 database ${db.name}.`);
    },
  }),
  contributeTool({
    name: 'cf_d1_tables',
    description:
      "List user tables and views in a D1 database. Args example: { database: 'my-db' }. " +
      'Follow up with cf_d1_table_schema or cf_d1_rows to inspect one.',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { database: { type: 'string' } }, required: ['database'] },
    handler: async (a, ctx) => {
      const r = await d1Query(
        ctx,
        reqString(a, 'database'),
        "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      );
      return { content: `${r.rows.length} table/view(s).`, data: { rows: r.rows, columns: r.columns } };
    },
  }),
  contributeTool({
    name: 'cf_d1_table_schema',
    description: 'Show columns/indexes/foreign keys for a D1 table',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { database: { type: 'string' }, table: { type: 'string' } },
      required: ['database', 'table'],
    },
    handler: async (a, ctx) => {
      const database = reqString(a, 'database');
      const table = reqString(a, 'table');
      const qtable = quoteIdent(table);
      const columns = await d1Query(ctx, database, `PRAGMA table_info(${qtable})`);
      const indexes = await d1Query(ctx, database, `PRAGMA index_list(${qtable})`);
      const fks = await d1Query(ctx, database, `PRAGMA foreign_key_list(${qtable})`);
      return ok(`Schema for ${table}.`, {
        columns: columns.rows,
        indexes: indexes.rows,
        foreignKeys: fks.rows,
      });
    },
  }),
  contributeTool({
    name: 'cf_d1_rows',
    description:
      'Browse rows in a D1 table with rowid pagination (default limit 50, max 200). ' +
      "Args example: { database: 'my-db', table: 'users', limit: 50, offset: 0 }.",
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: {
        database: { type: 'string' },
        table: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
      required: ['database', 'table'],
    },
    handler: async (a, ctx) => {
      const limit = Math.min(Math.max(optNumber(a, 'limit') ?? 50, 1), 200);
      const offset = Math.max(optNumber(a, 'offset') ?? 0, 0);
      const table = reqString(a, 'table');
      const r = await d1Query(
        ctx,
        reqString(a, 'database'),
        `SELECT rowid AS __rowid, * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`,
        [limit, offset],
      );
      return { content: `${r.rows.length} row(s).`, data: { rows: r.rows, columns: r.columns, limit, offset } };
    },
  }),
  contributeTool({
    name: 'cf_d1_row_insert',
    description: 'Insert a row into a D1 table; data is a JSON object',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { database: { type: 'string' }, table: { type: 'string' }, data: { type: 'object' } },
      required: ['database', 'table', 'data'],
    },
    handler: async (a, ctx) => {
      const data = rowData(a);
      const keys = Object.keys(data);
      const sql = `INSERT INTO ${quoteIdent(reqString(a, 'table'))} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
      const r = await d1Query(ctx, reqString(a, 'database'), sql, keys.map((k) => data[k]));
      return ok('Inserted row.', { details: r.raw });
    },
  }),
  contributeTool({
    name: 'cf_d1_row_update',
    description: 'Update a D1 row by rowid; data is a JSON object',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        database: { type: 'string' },
        table: { type: 'string' },
        rowid: { type: 'number' },
        data: { type: 'object' },
      },
      required: ['database', 'table', 'rowid', 'data'],
    },
    handler: async (a, ctx) => {
      const data = rowData(a);
      const keys = Object.keys(data);
      const rowid = optNumber(a, 'rowid');
      if (rowid == null) return fail('rowid is required');
      const sql = `UPDATE ${quoteIdent(reqString(a, 'table'))} SET ${keys.map((k) => `${quoteIdent(k)} = ?`).join(', ')} WHERE rowid = ?`;
      const r = await d1Query(ctx, reqString(a, 'database'), sql, [...keys.map((k) => data[k]), rowid]);
      return ok(`Updated row ${rowid}.`, { details: r.raw });
    },
  }),
  contributeTool({
    name: 'cf_d1_row_delete',
    description: 'Delete a D1 row by rowid',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { database: { type: 'string' }, table: { type: 'string' }, rowid: { type: 'number' } },
      required: ['database', 'table', 'rowid'],
    },
    handler: async (a, ctx) => {
      const rowid = optNumber(a, 'rowid');
      if (rowid == null) return fail('rowid is required');
      const r = await d1Query(ctx, reqString(a, 'database'), `DELETE FROM ${quoteIdent(reqString(a, 'table'))} WHERE rowid = ?`, [rowid]);
      return ok(`Deleted row ${rowid}.`, { details: r.raw });
    },
  }),
  contributeTool({
    name: 'cf_d1_query',
    description:
      'Run read-only SQL against a D1 database (use ? placeholders with `params`). ' +
      "Args example: { database: 'my-db', sql: 'SELECT * FROM users WHERE id = ?', params: [7] }. " +
      'For INSERT/UPDATE/DELETE/DDL use cf_d1_execute instead.',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { database: { type: 'string' }, sql: { type: 'string' }, params: { type: 'array' } },
      required: ['database', 'sql'],
    },
    handler: async (a, ctx) => {
      const r = await d1Query(ctx, reqString(a, 'database'), reqString(a, 'sql'), (a.params as unknown[]) ?? []);
      return { content: `${r.rows.length} row(s).`, data: { rows: r.rows, columns: cols(r.rows), meta: r.meta } };
    },
  }),
  contributeTool({
    name: 'cf_d1_execute',
    description:
      'Run mutating SQL (INSERT/UPDATE/DELETE/DDL) against a D1 database — destructive, confirm ' +
      'intent first; consider cf_d1_time_travel_bookmark before risky migrations. ' +
      "Args example: { database: 'my-db', sql: 'DELETE FROM logs WHERE ts < ?', params: [123] }.",
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { database: { type: 'string' }, sql: { type: 'string' }, params: { type: 'array' } },
      required: ['database', 'sql'],
    },
    handler: async (a, ctx) => {
      const r = await d1Query(ctx, reqString(a, 'database'), reqString(a, 'sql'), (a.params as unknown[]) ?? []);
      return ok('SQL executed.', { rows: r.rows, columns: r.columns, meta: r.meta, raw: r.raw });
    },
  }),
  contributeTool({
    name: 'cf_d1_export',
    description: 'Start a D1 export operation',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { database: { type: 'string' } }, required: ['database'] },
    handler: async (a, ctx) => {
      const db = await resolveD1Database(ctx, reqString(a, 'database'));
      const r = await cfAcct(ctx, `/d1/database/${db.uuid}/export`, { method: 'POST', body: JSON.stringify({}) });
      return ok(`Started export for ${db.name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_d1_import',
    description: 'Start a D1 import operation using a Cloudflare-supported import body',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { database: { type: 'string' }, body: { type: 'object' } }, required: ['database', 'body'] },
    handler: async (a, ctx) => {
      const db = await resolveD1Database(ctx, reqString(a, 'database'));
      const body = parseJson(a.body, {});
      const r = await cfAcct(ctx, `/d1/database/${db.uuid}/import`, { method: 'POST', body: JSON.stringify(body) });
      return ok(`Started import for ${db.name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_d1_time_travel_bookmark',
    description: 'Get the current D1 time-travel bookmark',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { database: { type: 'string' } }, required: ['database'] },
    handler: async (a, ctx) => {
      const db = await resolveD1Database(ctx, reqString(a, 'database'));
      const r = await cfAcct(ctx, `/d1/database/${db.uuid}/time_travel/bookmark`);
      return ok(`Time-travel bookmark for ${db.name}.`, { details: r });
    },
  }),
  contributeTool({
    name: 'cf_d1_time_travel_restore',
    description: 'Restore a D1 database to a bookmark',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { database: { type: 'string' }, bookmark: { type: 'string' } },
      required: ['database', 'bookmark'],
    },
    handler: async (a, ctx) => {
      const db = await resolveD1Database(ctx, reqString(a, 'database'));
      const r = await cfAcct(ctx, `/d1/database/${db.uuid}/time_travel/restore`, {
        method: 'POST',
        body: JSON.stringify({ bookmark: reqString(a, 'bookmark') }),
      });
      return ok(`Restore started for ${db.name}.`, { details: r });
    },
  }),
];
