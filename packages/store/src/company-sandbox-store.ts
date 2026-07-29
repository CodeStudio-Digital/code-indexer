import {
  CompanySessionFileCollection,
  type CompanyOperationalSessionStore,
} from './company-session-file-collection.js';

export type PersistedSandboxStatus =
  | 'provisioning'
  | 'running'
  | 'paused'
  | 'destroying'
  | 'destroyed'
  | 'error';

export interface PersistedSandboxRow {
  id: string;
  session_id: string;
  container_id: string;
  runtime: 'docker' | 'podman' | 'e2b';
  stack: string;
  workdir: string;
  host_workdir_mount: string | null;
  host_port: number;
  limits_json: string;
  status: PersistedSandboxStatus;
  error: string | null;
  mount_kind: 'owned' | 'external';
  image_source: 'default' | 'project_dockerfile';
  built_image_tag: string | null;
  dockerfile_path: string | null;
  dockerfile_exposed_port: number | null;
  last_access_at_ms: number;
  paused_at_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertSandboxInput {
  session_id: string;
  container_id: string;
  runtime: 'docker' | 'podman' | 'e2b';
  stack: string;
  workdir: string;
  host_workdir_mount?: string | null;
  host_port: number;
  limits: Record<string, unknown>;
  status: PersistedSandboxStatus;
  error?: string | null;
  mount_kind?: 'owned' | 'external';
  image_source?: 'default' | 'project_dockerfile';
  built_image_tag?: string | null;
  dockerfile_path?: string | null;
  dockerfile_exposed_port?: number | null;
  last_access_at_ms?: number;
  paused_at_ms?: number | null;
}

interface PrimarySandboxData {
  [key: string]: unknown;
  status: PersistedSandboxStatus;
  record_type: 'primary';
  container_id: string;
  runtime: 'docker' | 'podman' | 'e2b';
  stack: string;
  workdir: string;
  host_workdir_mount: string | null;
  host_port: number;
  limits_json: string;
  error: string | null;
  mount_kind: 'owned' | 'external';
  image_source: 'default' | 'project_dockerfile';
  built_image_tag: string | null;
  dockerfile_path: string | null;
  dockerfile_exposed_port: number | null;
  last_access_at_ms: number;
  paused_at_ms: number | null;
}

function dataFromInput(input: UpsertSandboxInput): PrimarySandboxData {
  return {
    status: input.status,
    record_type: 'primary',
    container_id: input.container_id,
    runtime: input.runtime,
    stack: input.stack,
    workdir: input.workdir,
    host_workdir_mount: input.host_workdir_mount ?? null,
    host_port: input.host_port,
    limits_json: JSON.stringify(input.limits ?? {}),
    error: input.error ?? null,
    mount_kind: input.mount_kind ?? 'owned',
    image_source: input.image_source ?? 'default',
    built_image_tag: input.built_image_tag ?? null,
    dockerfile_path: input.dockerfile_path ?? null,
    dockerfile_exposed_port: input.dockerfile_exposed_port ?? null,
    last_access_at_ms: input.last_access_at_ms ?? Date.now(),
    paused_at_ms: input.paused_at_ms ?? null,
  };
}

function mapRow(
  sessionId: string,
  record: ReturnType<CompanySessionFileCollection<PrimarySandboxData>['list']>[number],
): PersistedSandboxRow {
  return {
    id: record.id,
    session_id: sessionId,
    ...record.data,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export class CompanySandboxStore {
  private readonly files: CompanySessionFileCollection<PrimarySandboxData>;

  constructor(sessions: CompanyOperationalSessionStore) {
    this.files = new CompanySessionFileCollection(
      sessions,
      'sandboxes',
      'company.sandbox',
    );
  }

  upsert(input: UpsertSandboxInput): PersistedSandboxRow {
    const current = this.primaryRecord(input.session_id);
    const record = current
      ? this.files.update(input.session_id, current.id, () =>
          dataFromInput(input),
        )
      : this.files.create(input.session_id, { data: dataFromInput(input) });
    return mapRow(input.session_id, record);
  }

  patch(
    sessionId: string,
    patch: Partial<Omit<UpsertSandboxInput, 'session_id'>>,
  ): void {
    const current = this.primaryRecord(sessionId);
    if (!current) return;
    this.files.update(sessionId, current.id, (record) => {
      const data = { ...record.data };
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.container_id !== undefined) data.container_id = patch.container_id;
      if (patch.error !== undefined) data.error = patch.error;
      if (patch.last_access_at_ms !== undefined) data.last_access_at_ms = patch.last_access_at_ms;
      if (patch.paused_at_ms !== undefined) data.paused_at_ms = patch.paused_at_ms;
      if (patch.limits !== undefined) data.limits_json = JSON.stringify(patch.limits);
      if (patch.host_workdir_mount !== undefined) data.host_workdir_mount = patch.host_workdir_mount;
      if (patch.mount_kind !== undefined) data.mount_kind = patch.mount_kind;
      if (patch.image_source !== undefined) data.image_source = patch.image_source;
      if (patch.built_image_tag !== undefined) data.built_image_tag = patch.built_image_tag;
      if (patch.dockerfile_path !== undefined) data.dockerfile_path = patch.dockerfile_path;
      if (patch.dockerfile_exposed_port !== undefined) {
        data.dockerfile_exposed_port = patch.dockerfile_exposed_port;
      }
      return data;
    });
  }

  get(sessionId: string): PersistedSandboxRow | null {
    const record = this.primaryRecord(sessionId);
    return record ? mapRow(sessionId, record) : null;
  }

  listActive(): PersistedSandboxRow[] {
    return this.files
      .listAcrossSessions()
      .filter(
        ({ record }) =>
          record.data.record_type === 'primary' &&
          record.data.status !== 'destroyed',
      )
      .map(({ sessionId, record }) => mapRow(sessionId, record))
      .sort((left, right) => right.last_access_at_ms - left.last_access_at_ms);
  }

  listPausedOlderThan(maxPausedMs: number): PersistedSandboxRow[] {
    const cutoff = Date.now() - maxPausedMs;
    return this.listActive().filter(
      (row) =>
        row.status === 'paused' &&
        row.paused_at_ms !== null &&
        row.paused_at_ms < cutoff,
    );
  }

  delete(sessionId: string): void {
    const current = this.primaryRecord(sessionId);
    if (current) this.files.moveToTrash(sessionId, current.id);
  }

  private primaryRecord(sessionId: string) {
    return (
      this.files
        .list(sessionId)
        .find((record) => record.data.record_type === 'primary') ?? null
    );
  }
}
