import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type McpApprovalMode = 'read_only' | 'controlled' | 'admin';

export interface McpConnectionProfile {
  id: string;
  name: string;
  description: string;
  projectIds: number[];
  toolAllowlist: string[];
  agentAllowlist: string[];
  approvalMode: McpApprovalMode;
  maxConcurrentRuns: number;
  maxRuntimeMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertMcpConnectionProfileInput {
  id: string;
  name: string;
  description?: string;
  projectIds?: number[];
  toolAllowlist?: string[];
  agentAllowlist?: string[];
  approvalMode?: McpApprovalMode;
  maxConcurrentRuns?: number;
  maxRuntimeMs?: number;
}

interface ProfileRow {
  id: string;
  name: string;
  description: string;
  project_ids: string;
  tool_allowlist: string;
  agent_allowlist: string;
  approval_mode: McpApprovalMode;
  max_concurrent_runs: number;
  max_runtime_ms: number;
  created_at: number;
  updated_at: number;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
}

function projectList(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('projectIds must be an array');
  const ids = value.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('projectIds must contain positive integer project IDs');
  }
  return [...new Set(ids)];
}

function parseList<T extends string | number>(raw: string): T[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function hydrate(row: ProfileRow): McpConnectionProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    projectIds: parseList<number>(row.project_ids),
    toolAllowlist: parseList<string>(row.tool_allowlist),
    agentAllowlist: parseList<string>(row.agent_allowlist),
    approvalMode: row.approval_mode,
    maxConcurrentRuns: row.max_concurrent_runs,
    maxRuntimeMs: row.max_runtime_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class McpConnectionProfileStore {
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

  listProfiles(): McpConnectionProfile[] {
    return (this.db.prepare(
      'SELECT * FROM mcp_connection_profiles ORDER BY name COLLATE NOCASE',
    ).all() as ProfileRow[]).map(hydrate);
  }

  getProfile(id: string): McpConnectionProfile | null {
    const row = this.db.prepare(
      'SELECT * FROM mcp_connection_profiles WHERE id = ?',
    ).get(id) as ProfileRow | undefined;
    return row ? hydrate(row) : null;
  }

  upsertProfile(input: UpsertMcpConnectionProfileInput): McpConnectionProfile {
    const id = input.id.trim();
    const name = input.name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      throw new Error('Profile id must use 1-64 lowercase letters, numbers, hyphens or underscores');
    }
    if (!name || name.length > 120) throw new Error('Profile name must use 1-120 characters');

    const existing = this.getProfile(id);
    const approvalMode = input.approvalMode ?? existing?.approvalMode ?? 'controlled';
    if (!['read_only', 'controlled', 'admin'].includes(approvalMode)) {
      throw new Error('Invalid approvalMode');
    }
    const maxConcurrentRuns = input.maxConcurrentRuns ?? existing?.maxConcurrentRuns ?? 2;
    const maxRuntimeMs = input.maxRuntimeMs ?? existing?.maxRuntimeMs ?? 1_800_000;
    if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 16) {
      throw new Error('maxConcurrentRuns must be between 1 and 16');
    }
    if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1_000 || maxRuntimeMs > 86_400_000) {
      throw new Error('maxRuntimeMs must be between 1000 and 86400000');
    }

    const now = Date.now();
    const projectIds = projectList(input.projectIds ?? existing?.projectIds ?? []);
    const toolAllowlist = stringList(input.toolAllowlist ?? existing?.toolAllowlist ?? [], 'toolAllowlist');
    const agentAllowlist = stringList(input.agentAllowlist ?? existing?.agentAllowlist ?? [], 'agentAllowlist');

    this.db.prepare(`
      INSERT INTO mcp_connection_profiles (
        id, name, description, project_ids, tool_allowlist, agent_allowlist,
        approval_mode, max_concurrent_runs, max_runtime_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        project_ids = excluded.project_ids,
        tool_allowlist = excluded.tool_allowlist,
        agent_allowlist = excluded.agent_allowlist,
        approval_mode = excluded.approval_mode,
        max_concurrent_runs = excluded.max_concurrent_runs,
        max_runtime_ms = excluded.max_runtime_ms,
        updated_at = excluded.updated_at
    `).run(
      id,
      name,
      (input.description ?? existing?.description ?? '').trim().slice(0, 500),
      JSON.stringify(projectIds),
      JSON.stringify(toolAllowlist),
      JSON.stringify(agentAllowlist),
      approvalMode,
      maxConcurrentRuns,
      maxRuntimeMs,
      existing?.createdAt ?? now,
      now,
    );
    return this.getProfile(id)!;
  }

  deleteProfile(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_connection_profiles WHERE id = ?').run(id).changes > 0;
  }
}
