/**
 * Migration 201 — layout do modo Blueprint do App Studio.
 *
 * `app_studio_sessions.blueprint_json`: posições x/y dos nós do canvas
 * ({ v:1, positions: Record<nodeId,{x,y}> }, schema TS em
 * @mcp/app-studio/blueprint/types.ts). Separado da spec_json de propósito:
 * a spec é o contrato SEMÂNTICO do app (o agente constrói a partir dela);
 * o layout é apresentação — muda num drag, salva sem lock (mesmo com a
 * spec travada pós-aprovação do discovery) e nunca dispara reconcile.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const appStudioBlueprint201: Migration = {
  version: 201,
  name: 'app_studio_blueprint',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'app_studio_sessions', 'blueprint_json', 'TEXT');
  },
};
