import {
  EntityFileRepository,
  isUuid,
  type EntityRecord,
  type ProjectId,
  type SessionId,
  type SessionStorageScope,
} from '@mcp/session-storage';
import { FsSessionDirectory } from './session-directory.js';
import type { FsSessionGroup } from './operational-types.js';

interface GroupData {
  project_id: ProjectId | null;
  name: string;
  color: string | null;
  sort_order: number;
}

function group(record: EntityRecord<GroupData>): FsSessionGroup {
  return {
    id: record.id,
    seq: record.seq,
    project_id: record.data.project_id,
    name: record.data.name,
    color: record.data.color,
    sort_order: record.data.sort_order,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export class FsSessionGroupRepository {
  private readonly repositories = new Map<
    string,
    EntityFileRepository<GroupData>
  >();

  constructor(private readonly directory: FsSessionDirectory) {}

  private scope(projectId: ProjectId | null): SessionStorageScope {
    return projectId == null
      ? { kind: 'global' }
      : { kind: 'project', project_id: projectId };
  }

  private async repository(
    projectId: ProjectId | null,
  ): Promise<EntityFileRepository<GroupData>> {
    const key = projectId == null ? 'global' : `project:${projectId}`;
    const existing = this.repositories.get(key);
    if (existing) return existing;
    const root = await this.directory.locator.ensureSessionRoot(
      this.scope(projectId),
    );
    const created = new EntityFileRepository<GroupData>({
      sessionRoot: root,
      namespace: 'groups',
      kind: 'session_group',
    });
    this.repositories.set(key, created);
    return created;
  }

  async list(projectId: ProjectId | null): Promise<FsSessionGroup[]> {
    const repository = await this.repository(projectId);
    const output: FsSessionGroup[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.list({
        order: 'asc',
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      output.push(...page.items.map(group));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return output.sort(
      (left, right) =>
        left.sort_order - right.sort_order ||
        left.seq - right.seq,
    );
  }

  async create(
    projectId: ProjectId | null,
    input: {
      name: string;
      color?: string | null;
      sort_order?: number;
    },
  ): Promise<FsSessionGroup> {
    const repository = await this.repository(projectId);
    return group(
      await repository.create({
        data: {
          project_id: projectId,
          name: input.name,
          color: input.color ?? null,
          sort_order: input.sort_order ?? 0,
        },
      }),
    );
  }

  async update(
    projectId: ProjectId | null,
    groupId: string,
    patch: {
      name?: string;
      color?: string | null;
      sort_order?: number;
    },
  ): Promise<FsSessionGroup | null> {
    if (!isUuid(groupId)) return null;
    const repository = await this.repository(projectId);
    const current = await repository.get(groupId);
    if (!current) return null;
    return group(
      await repository.update(groupId, {
        data: {
          ...current.data,
          ...patch,
        },
      }),
    );
  }

  async delete(
    projectId: ProjectId | null,
    groupId: string,
  ): Promise<boolean> {
    if (!isUuid(groupId)) return false;
    const repository = await this.repository(projectId);
    if (!(await repository.get(groupId))) return false;
    await repository.moveToTrash(groupId);
    await this.directory.ensureCatalog();
    const sessions = this.directory.catalog.list().filter((entry) => {
      if (projectId == null) {
        return entry.session.storage_scope.kind === 'global';
      }
      return (
        entry.session.storage_scope.kind === 'project' &&
        entry.session.storage_scope.project_id === projectId
      );
    });
    for (const session of sessions) {
      const state =
        session.state ??
        this.directory.repository.readStateSync(session.location);
      const runtime =
        state.extra.runtime &&
        typeof state.extra.runtime === 'object' &&
        !Array.isArray(state.extra.runtime)
          ? state.extra.runtime
          : {};
      if ((runtime as Record<string, unknown>).group_id !== groupId) continue;
      await this.setSessionGroup(session.session.id, null);
    }
    return true;
  }

  async setSessionGroup(
    sessionId: SessionId | string,
    groupId: string | null,
  ): Promise<void> {
    const entry = await this.directory.requireEntry(sessionId);
    const projectId =
      entry.session.storage_scope.kind === 'project'
        ? entry.session.storage_scope.project_id
        : null;
    if (groupId != null) {
      if (!isUuid(groupId)) throw new TypeError('group id must be a UUID');
      const repository = await this.repository(projectId);
      if (!(await repository.get(groupId))) {
        throw new Error(`Unknown session group ${groupId}`);
      }
    }
    await this.directory.runMutation(sessionId, async () => {
      await this.directory.repository.updateState(
        entry.location,
        (state) => {
          const runtime =
            state.extra.runtime &&
            typeof state.extra.runtime === 'object' &&
            !Array.isArray(state.extra.runtime)
              ? state.extra.runtime
              : {};
          return {
            ...state,
            extra: {
              ...state.extra,
              runtime: { ...runtime, group_id: groupId },
            },
          };
        },
      );
    });
  }
}
