import type { PersistedSandboxStatus } from './company-sandbox-store.js';
import type { UpdateServiceHealthInput } from './company-sandbox-services-health.js';
import {
  CompanySessionFileCollection,
  type CompanyOperationalSessionStore,
} from './company-session-file-collection.js';

export interface PersistedSandboxServiceRow {
  id: string;
  session_id: string;
  service_id: string;
  name: string;
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
  is_primary: 0 | 1;
  last_access_at_ms: number;
  paused_at_ms: number | null;
  created_at: string;
  updated_at: string;
  is_attached: 0 | 1;
  external_container_ref: string | null;
  attached_hostname: string | null;
  health: string;
  health_detail: string | null;
  last_health_at_ms: number | null;
  restart_count: number;
}

export interface UpsertSandboxServiceInput {
  session_id: string;
  service_id: string;
  name?: string;
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
  is_primary?: boolean;
  last_access_at_ms?: number;
  paused_at_ms?: number | null;
  is_attached?: boolean;
  external_container_ref?: string | null;
  attached_hostname?: string | null;
}

interface SandboxServiceData {
  [key: string]: unknown;
  status: PersistedSandboxStatus;
  record_type: 'service';
  service_id: string;
  name: string;
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
  is_primary: 0 | 1;
  last_access_at_ms: number;
  paused_at_ms: number | null;
  is_attached: 0 | 1;
  external_container_ref: string | null;
  attached_hostname: string | null;
  health: string;
  health_detail: string | null;
  last_health_at_ms: number | null;
  restart_count: number;
}

function createData(input: UpsertSandboxServiceInput): SandboxServiceData {
  return {
    status: input.status,
    record_type: 'service',
    service_id: input.service_id,
    name: input.name ?? '',
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
    is_primary: input.is_primary ? 1 : 0,
    last_access_at_ms: input.last_access_at_ms ?? Date.now(),
    paused_at_ms: input.paused_at_ms ?? null,
    is_attached: input.is_attached ? 1 : 0,
    external_container_ref: input.external_container_ref ?? null,
    attached_hostname: input.attached_hostname ?? null,
    health: 'unknown',
    health_detail: null,
    last_health_at_ms: null,
    restart_count: 0,
  };
}

function mapRow(
  sessionId: string,
  record: ReturnType<CompanySessionFileCollection<SandboxServiceData>['list']>[number],
): PersistedSandboxServiceRow {
  return {
    id: record.id,
    session_id: sessionId,
    ...record.data,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export class CompanySandboxServicesStore {
  private readonly files: CompanySessionFileCollection<SandboxServiceData>;

  constructor(sessions: CompanyOperationalSessionStore) {
    this.files = new CompanySessionFileCollection(
      sessions,
      'sandboxes',
      'company.sandbox',
    );
  }

  updateHealth(
    sessionId: string,
    serviceId: string,
    input: UpdateServiceHealthInput,
  ): boolean {
    const current = this.serviceRecord(sessionId, serviceId);
    if (!current) return false;
    this.files.update(sessionId, current.id, (record) => ({
      ...record.data,
      health: input.health,
      health_detail: input.healthDetail ?? null,
      last_health_at_ms: input.lastHealthAtMs ?? Date.now(),
    }));
    return true;
  }

  bumpRestartCount(sessionId: string, serviceId: string): number | null {
    const current = this.serviceRecord(sessionId, serviceId);
    if (!current) return null;
    const updated = this.files.update(sessionId, current.id, (record) => ({
      ...record.data,
      restart_count: record.data.restart_count + 1,
    }));
    return updated.data.restart_count;
  }

  upsert(input: UpsertSandboxServiceInput): PersistedSandboxServiceRow {
    const current = this.serviceRecord(input.session_id, input.service_id);
    const data = createData(input);
    if (current) {
      data.health = current.data.health;
      data.health_detail = current.data.health_detail;
      data.last_health_at_ms = current.data.last_health_at_ms;
      data.restart_count = current.data.restart_count;
    }
    const record = current
      ? this.files.update(input.session_id, current.id, () => data)
      : this.files.create(input.session_id, { data });
    return mapRow(input.session_id, record);
  }

  releaseStaleContainerId(
    containerId: string,
    excludeSessionId: string,
    excludeServiceId: string,
  ): number {
    return this.releaseStale(
      (row) => row.container_id === containerId,
      excludeSessionId,
      excludeServiceId,
    );
  }

  releaseStaleHostPort(
    hostPort: number,
    excludeSessionId: string,
    excludeServiceId: string,
  ): number {
    return this.releaseStale(
      (row) => row.host_port === hostPort,
      excludeSessionId,
      excludeServiceId,
    );
  }

  patch(
    sessionId: string,
    serviceId: string,
    patch: Partial<Omit<UpsertSandboxServiceInput, 'session_id' | 'service_id'>>,
  ): void {
    const current = this.serviceRecord(sessionId, serviceId);
    if (!current) return;
    this.files.update(sessionId, current.id, (record) => {
      const data = { ...record.data };
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.container_id !== undefined) data.container_id = patch.container_id;
      if (patch.error !== undefined) data.error = patch.error;
      if (patch.last_access_at_ms !== undefined) data.last_access_at_ms = patch.last_access_at_ms;
      if (patch.paused_at_ms !== undefined) data.paused_at_ms = patch.paused_at_ms;
      if (patch.limits !== undefined) data.limits_json = JSON.stringify(patch.limits);
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.is_primary !== undefined) data.is_primary = patch.is_primary ? 1 : 0;
      if (patch.mount_kind !== undefined) data.mount_kind = patch.mount_kind;
      if (patch.image_source !== undefined) data.image_source = patch.image_source;
      if (patch.built_image_tag !== undefined) data.built_image_tag = patch.built_image_tag;
      if (patch.dockerfile_path !== undefined) data.dockerfile_path = patch.dockerfile_path;
      if (patch.dockerfile_exposed_port !== undefined) {
        data.dockerfile_exposed_port = patch.dockerfile_exposed_port;
      }
      if (patch.is_attached !== undefined) data.is_attached = patch.is_attached ? 1 : 0;
      if (patch.external_container_ref !== undefined) {
        data.external_container_ref = patch.external_container_ref;
      }
      if (patch.attached_hostname !== undefined) {
        data.attached_hostname = patch.attached_hostname;
      }
      return data;
    });
  }

  get(sessionId: string, serviceId: string): PersistedSandboxServiceRow | null {
    const record = this.serviceRecord(sessionId, serviceId);
    return record ? mapRow(sessionId, record) : null;
  }

  listBySession(sessionId: string): PersistedSandboxServiceRow[] {
    return this.listBySessionAll(sessionId).filter(
      (row) => row.status !== 'destroyed',
    );
  }

  listBySessionAll(sessionId: string): PersistedSandboxServiceRow[] {
    return this.files
      .list(sessionId)
      .filter((record) => record.data.record_type === 'service')
      .map((record) => mapRow(sessionId, record))
      .sort(
        (left, right) =>
          right.is_primary - left.is_primary ||
          left.created_at.localeCompare(right.created_at),
      );
  }

  listActive(): PersistedSandboxServiceRow[] {
    return this.files
      .listAcrossSessions()
      .filter(
        ({ record }) =>
          record.data.record_type === 'service' &&
          record.data.status !== 'destroyed',
      )
      .map(({ sessionId, record }) => mapRow(sessionId, record))
      .sort((left, right) => right.last_access_at_ms - left.last_access_at_ms);
  }

  delete(sessionId: string, serviceId: string): void {
    const current = this.serviceRecord(sessionId, serviceId);
    if (current) this.files.moveToTrash(sessionId, current.id);
  }

  deleteAllForSession(sessionId: string): void {
    for (const row of this.listBySessionAll(sessionId)) {
      this.files.moveToTrash(sessionId, row.id);
    }
  }

  private serviceRecord(sessionId: string, serviceId: string) {
    return (
      this.files
        .list(sessionId)
        .find(
          (record) =>
            record.data.record_type === 'service' &&
            record.data.service_id === serviceId,
        ) ?? null
    );
  }

  private releaseStale(
    matches: (row: PersistedSandboxServiceRow) => boolean,
    excludeSessionId: string,
    excludeServiceId: string,
  ): number {
    let changed = 0;
    for (const row of this.listActive()) {
      if (
        !matches(row) ||
        (row.session_id === excludeSessionId &&
          row.service_id === excludeServiceId)
      ) {
        continue;
      }
      this.patch(row.session_id, row.service_id, { status: 'destroyed' });
      changed += 1;
    }
    return changed;
  }
}
