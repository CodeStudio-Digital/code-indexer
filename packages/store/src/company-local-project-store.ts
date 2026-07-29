/**
 * Filesystem persistence for the retired host-process Company runner.
 *
 * The row is retained only so a restart can show/clean up the last process
 * state. Runtime state is scoped to the owning Company bundle and never
 * touches SQLite.
 */

import {
  CompanySessionFileCollection,
  type CompanyOperationalSessionStore,
} from './company-session-file-collection.js';

export type LocalProjectStatus =
  | 'provisioning'
  | 'running'
  | 'destroying'
  | 'destroyed'
  | 'error';

export type LocalProjectSynthSource = 'ai' | 'fallback' | 'fallback-after-ai-failure';

export type LocalProjectManifestKind = 'node' | 'python' | 'go' | 'rust' | 'ruby';

export interface PersistedLocalProjectRow {
  id: string;
  seq: number;
  session_id: string;
  cwd: string;
  manifest_kind: LocalProjectManifestKind;
  program: string;
  args_json: string;
  /**
   * Kept for wire compatibility only. Host-run environment values may contain
   * secrets, so this filesystem projection deliberately persists an empty
   * object. The host-process launch endpoint is retired and cannot be resumed
   * from this record.
   */
  env_json: string;
  host_port: number;
  rationale: string;
  synth_source: LocalProjectSynthSource;
  status: LocalProjectStatus;
  error: string | null;
  pid: number | null;
  last_access_at_ms: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertLocalProjectInput {
  session_id: string;
  cwd: string;
  manifest_kind: LocalProjectManifestKind;
  program: string;
  args: readonly string[];
  env: Record<string, string>;
  host_port: number;
  rationale: string;
  synth_source: LocalProjectSynthSource;
  status: LocalProjectStatus;
  error?: string | null;
  pid?: number | null;
  last_access_at_ms?: number;
}

interface LocalProjectData {
  [key: string]: unknown;
  record_type: 'local-project';
  cwd: string;
  manifest_kind: LocalProjectManifestKind;
  program: string;
  args_json: string;
  env_json: '{}';
  host_port: number;
  rationale: string;
  synth_source: LocalProjectSynthSource;
  status: LocalProjectStatus;
  error: string | null;
  pid: number | null;
  last_access_at_ms: number;
}

function dataFromInput(input: UpsertLocalProjectInput): LocalProjectData {
  return {
    record_type: 'local-project',
    cwd: input.cwd,
    manifest_kind: input.manifest_kind,
    program: input.program,
    args_json: JSON.stringify([...input.args]),
    env_json: '{}',
    host_port: input.host_port,
    rationale: input.rationale,
    synth_source: input.synth_source,
    status: input.status,
    error: input.error ?? null,
    pid: input.pid ?? null,
    last_access_at_ms: input.last_access_at_ms ?? Date.now(),
  };
}

function mapRow(
  sessionId: string,
  record: ReturnType<CompanySessionFileCollection<LocalProjectData>['list']>[number],
): PersistedLocalProjectRow {
  return {
    id: record.id,
    seq: record.seq,
    session_id: sessionId,
    ...record.data,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export class CompanyLocalProjectStore {
  private readonly files: CompanySessionFileCollection<LocalProjectData>;

  constructor(sessions: CompanyOperationalSessionStore) {
    this.files = new CompanySessionFileCollection(
      sessions,
      'services',
      'company.service',
    );
  }

  upsert(input: UpsertLocalProjectInput): PersistedLocalProjectRow {
    const current = this.record(input.session_id);
    const next = current
      ? this.files.update(input.session_id, current.id, () => dataFromInput(input))
      : this.files.create(input.session_id, { data: dataFromInput(input) });
    return mapRow(input.session_id, next);
  }

  patch(
    sessionId: string,
    patch: Partial<{
      status: LocalProjectStatus;
      error: string | null;
      pid: number | null;
      last_access_at_ms: number;
    }>,
  ): void {
    const current = this.record(sessionId);
    if (!current) return;
    this.files.update(sessionId, current.id, (record) => ({
      ...record.data,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.pid !== undefined ? { pid: patch.pid } : {}),
      ...(patch.last_access_at_ms !== undefined
        ? { last_access_at_ms: patch.last_access_at_ms }
        : {}),
    }));
  }

  get(sessionId: string): PersistedLocalProjectRow | null {
    const record = this.record(sessionId);
    return record ? mapRow(sessionId, record) : null;
  }

  listActive(): PersistedLocalProjectRow[] {
    return this.files
      .listAcrossSessions()
      .filter(
        ({ record }) =>
          record.data.record_type === 'local-project' &&
          record.data.status !== 'destroyed',
      )
      .map(({ sessionId, record }) => mapRow(sessionId, record))
      .sort((left, right) => right.last_access_at_ms - left.last_access_at_ms);
  }

  listBySession(sessionId: string): PersistedLocalProjectRow | null {
    const row = this.get(sessionId);
    return row?.status === 'destroyed' ? null : row;
  }

  delete(sessionId: string): void {
    const current = this.record(sessionId);
    if (current) this.files.moveToTrash(sessionId, current.id);
  }

  /**
   * Host processes cannot be re-parented after a server restart. Mark every
   * non-terminal record interrupted and return its PID for best-effort OS
   * cleanup.
   */
  reconcileOnBoot(): { cleaned: number; orphanedPids: number[] } {
    const active = this.listActive().filter((row) =>
      row.status === 'provisioning' ||
      row.status === 'running' ||
      row.status === 'destroying',
    );
    const orphanedPids = active
      .map((row) => row.pid)
      .filter((pid): pid is number => pid !== null);
    for (const row of active) {
      this.patch(row.session_id, {
        status: 'destroyed',
        error: row.error ?? 'server-restart',
      });
    }
    return { cleaned: active.length, orphanedPids };
  }

  private record(sessionId: string) {
    return (
      this.files
        .list(sessionId)
        .find((record) => record.data.record_type === 'local-project') ?? null
    );
  }
}
