import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { removeAgentPipelines265 } from '../265_remove_agent_pipelines.js';

let db: InstanceType<typeof Database> | undefined;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => db?.close());

describe('migration 265 - remove agent pipelines', () => {
  it('drops definitions and executions in dependency order', () => {
    db!.exec(`
      CREATE TABLE pipelines (id INTEGER PRIMARY KEY);
      CREATE TABLE pipeline_executions (
        id TEXT PRIMARY KEY,
        pipeline_id INTEGER NOT NULL REFERENCES pipelines(id)
      );
      CREATE TABLE pipeline_node_executions (
        id INTEGER PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES pipeline_executions(id)
      );
    `);

    removeAgentPipelines265.up(db!);
    removeAgentPipelines265.up(db!);

    expect(db!.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('pipelines', 'pipeline_executions', 'pipeline_node_executions')
    `).all()).toEqual([]);
  });
});
