import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readAgentMemoryCoverage } from '../agent-memory-coverage.js';

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:'); opened.push(db);
  db.exec(`CREATE TABLE agent_memory(id INTEGER,scope TEXT,project_id INTEGER,archived_at TEXT);
    CREATE TABLE semantic_namespace_generations(namespace TEXT,active_generation_id INTEGER,delta_items INTEGER);
    CREATE TABLE semantic_items(generation_id INTEGER,namespace TEXT,item_key TEXT,status TEXT,vector_id TEXT);
    INSERT INTO semantic_namespace_generations VALUES('memory:project:p7',2,3);
    INSERT INTO agent_memory VALUES(1,'project',7,NULL),(2,'project',7,NULL),(3,'project',7,NULL),
      (4,'project',7,NULL),(5,'project',7,'archived'),(6,'project',8,NULL),(7,'user',0,NULL);
    INSERT INTO semantic_items VALUES(2,'memory:project:p7','agent_memory:1','indexed','v1'),
      (2,'memory:project:p7','agent_memory:1','indexed','v2'),
      (2,'memory:project:p7','agent_memory:2','indexed','v3'),
      (2,'memory:project:p7','agent_memory:2','failed',NULL),
      (2,'memory:project:p7','agent_memory:4','pending',NULL),
      (2,'memory:project:p7','agent_memory:5','indexed','v5'),
      (1,'memory:project:p7','agent_memory:3','indexed','old');`);
  return db;
}
describe('live memory vector coverage', () => {
  it('counts identities, requires all recorded chunks, and excludes archived or old generations', () => {
    expect(readAgentMemoryCoverage(fixture(),7,'project')).toEqual({namespace:'memory:project:p7',generationId:2,
      live:4,indexed:1,failed:1,missing:1,pending:1,queuedMutations:3});
  });
  it('reports global stock without creating a generation or touching other projects', () => {
    const db=fixture();
    expect(readAgentMemoryCoverage(db,7,'user')).toMatchObject({namespace:'memory:user',generationId:null,live:1,indexed:0,missing:1});
    expect(db.prepare('SELECT COUNT(*) n FROM semantic_namespace_generations').get()).toEqual({n:1});
  });
});
