import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { agentMemoryEvolution275 } from '../275_agent_memory_evolution.js';

it('adds durable maintenance state idempotently and disables only the two retired bindings without deleting settings', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY);
      CREATE TABLE agent_memory(id INTEGER PRIMARY KEY,scope TEXT,project_id INTEGER,archived_at TEXT,source TEXT);
      CREATE TABLE pipeline_provider_bindings(pipeline_name TEXT,enabled INTEGER,config TEXT);
      INSERT INTO pipeline_provider_bindings VALUES ('memory_query',1,'saved'),('memory_recall',1,'saved'),('memory_extraction',1,'saved');`);
    agentMemoryEvolution275.up(db); agentMemoryEvolution275.up(db);
    expect(db.prepare('SELECT pipeline_name,enabled FROM pipeline_provider_bindings ORDER BY pipeline_name').all()).toEqual([
      { pipeline_name: 'memory_extraction', enabled: 1 }, { pipeline_name: 'memory_query', enabled: 0 }, { pipeline_name: 'memory_recall', enabled: 0 },
    ]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_memory_evolution'").get()).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_provider_bindings').get()).toEqual({ n: 3 });
  } finally { db.close(); }
});
it('does not assume shared tables exist in a trimmed project database', () => {
  const db = new Database(':memory:');
  try { expect(() => agentMemoryEvolution275.up(db)).not.toThrow(); } finally { db.close(); }
});
