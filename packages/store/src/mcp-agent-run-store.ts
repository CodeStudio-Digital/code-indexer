import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type McpAgentRunStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface McpAgentRun {
  id: string;
  principal: string;
  profileId: string | null;
  sessionId: number | null;
  projectId: number | null;
  agentId: string;
  status: McpAgentRunStatus;
  taskPreview: string;
  finalText: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RunRow {
  id: string;
  principal: string;
  profile_id: string | null;
  session_id: number | null;
  project_id: number | null;
  agent_id: string;
  status: McpAgentRunStatus;
  task_preview: string;
  final_text: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function hydrate(row: RunRow): McpAgentRun {
  return {
    id: row.id,
    principal: row.principal,
    profileId: row.profile_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    status: row.status,
    taskPreview: row.task_preview,
    finalText: row.final_text,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class McpAgentRunStore {
  private readonly db: DB;
  private readonly ownsConnection: boolean;

  constructor(dbPathOrInstance: string | DB) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  create(run: Omit<McpAgentRun, 'createdAt' | 'updatedAt'>): McpAgentRun {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO mcp_agent_runs (
        id, principal, profile_id, session_id, project_id, agent_id, status,
        task_preview, final_text, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.principal, run.profileId, run.sessionId, run.projectId,
      run.agentId, run.status, run.taskPreview, run.finalText, run.error, now, now,
    );
    return this.get(run.id)!;
  }

  get(id: string): McpAgentRun | null {
    const row = this.db.prepare('SELECT * FROM mcp_agent_runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? hydrate(row) : null;
  }

  update(id: string, patch: Partial<Pick<McpAgentRun, 'sessionId' | 'status' | 'finalText' | 'error'>>): McpAgentRun | null {
    const current = this.get(id);
    if (!current) return null;
    this.db.prepare(`
      UPDATE mcp_agent_runs SET session_id = ?, status = ?, final_text = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.sessionId ?? current.sessionId,
      patch.status ?? current.status,
      patch.finalText === undefined ? current.finalText : patch.finalText,
      patch.error === undefined ? current.error : patch.error,
      Date.now(),
      id,
    );
    return this.get(id);
  }

  listForPrincipal(principal: string, limit = 50): McpAgentRun[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT * FROM mcp_agent_runs WHERE principal = ? ORDER BY created_at DESC LIMIT ?
    `).all(principal, safeLimit) as RunRow[]).map(hydrate);
  }

  countActive(principal: string, profileId: string | null): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM mcp_agent_runs
      WHERE principal = ? AND profile_id IS ? AND status IN ('starting', 'running')
    `).get(principal, profileId) as { count: number };
    return row.count;
  }

  interruptActiveRuns(): number {
    return this.db.prepare(`
      UPDATE mcp_agent_runs SET status = 'interrupted', error = ?, updated_at = ?
      WHERE status IN ('starting', 'running')
    `).run('CodeStudio restarted before this run finished', Date.now()).changes;
  }
}
