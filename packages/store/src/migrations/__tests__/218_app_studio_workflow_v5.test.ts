import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { CENTRAL_DROP_TABLES } from '../../project-db/trim/drop-list.js';
import { appStudioWorkflowV5218 } from '../218_app_studio_workflow_v5.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

const WORKFLOW_TABLES = [
  'app_studio_workflow_snapshots',
  'app_studio_delivery_blueprints',
  'app_studio_work_items',
  'app_studio_approvals',
  'app_studio_decision_requests',
  'app_studio_workflow_events',
] as const;

function tableExists(table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 218 — App Studio workflow v5', () => {
  it('no-ops when App Studio was removed from a trimmed project DB', () => {
    expect(tableExists('app_studio_sessions')).toBe(false);

    expect(() => appStudioWorkflowV5218.up(db)).not.toThrow();

    expect(tableExists('app_studio_sessions')).toBe(false);
    for (const table of WORKFLOW_TABLES) expect(tableExists(table)).toBe(false);
  });

  it('upgrades a central DB idempotently', () => {
    db.exec('CREATE TABLE app_studio_sessions (id INTEGER PRIMARY KEY)');

    expect(() => {
      appStudioWorkflowV5218.up(db);
      appStudioWorkflowV5218.up(db);
    }).not.toThrow();

    expect(columnNames('app_studio_sessions').filter((column) => column === 'coordinator_session_id')).toHaveLength(1);
    for (const table of WORKFLOW_TABLES) expect(tableExists(table)).toBe(true);
  });

  it('classifies every workflow table as central-only for fresh project DB trimming', () => {
    expect(CENTRAL_DROP_TABLES).toEqual(expect.arrayContaining([...WORKFLOW_TABLES]));
  });
});
