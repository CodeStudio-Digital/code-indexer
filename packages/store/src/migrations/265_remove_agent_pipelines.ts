import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/** Remove the retired visual/executable agent pipeline feature. */
export const removeAgentPipelines265: Migration = {
  version: 265,
  name: 'remove_agent_pipelines',
  up(db: DB): void {
    db.exec(`
      DROP TABLE IF EXISTS pipeline_node_executions;
      DROP TABLE IF EXISTS pipeline_executions;
      DROP TABLE IF EXISTS pipelines;
    `);
  },
};
