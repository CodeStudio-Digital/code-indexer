import {
  assertExistingDirectory,
  type JsonValue,
  type ProjectId,
  type RestoreResult,
  type SessionId,
  type SessionLocation,
  type SessionMetadata,
  type TrashedSessionEntry,
  type TrashResult,
} from '@mcp/session-storage';
import { toJsonValue } from './conversation-codec.js';
import { coderMetadata } from './session-projection.js';
import { FsSessionDirectory } from './session-directory.js';
import type {
  FsCoderSessionStatus,
  FsLinkedProject,
  FsLinkProjectInput,
} from './types.js';

export class FsSessionMutations {
  constructor(private readonly directory: FsSessionDirectory) {}

  async setAgent(id: SessionId | string, agent: string | null): Promise<void> {
    const found = await this.directory.requireEntry(id);
    await this.directory.updateCoderMetadata(found.location, (current) => ({
      ...current,
      agent,
    }));
  }

  async setTitle(id: SessionId | string, title: string): Promise<void> {
    const found = await this.directory.requireEntry(id);
    await this.directory.repository.updateSession(
      found.location,
      (session) => ({ ...session, title }),
    );
  }

  async setFavorite(
    id: SessionId | string,
    favorite: boolean,
  ): Promise<void> {
    const found = await this.directory.requireEntry(id);
    const at = favorite ? new Date().toISOString() : null;
    await this.directory.repository.updateSession(found.location, (session) => {
      const coder = coderMetadata(session.metadata);
      return {
        ...session,
        favorite,
        metadata: {
          ...session.metadata,
          coder: toJsonValue({ ...coder, favorited_at: at }),
        },
      };
    });
  }

  async setArchived(
    id: SessionId | string,
    archived: boolean,
  ): Promise<void> {
    const found = await this.directory.requireEntry(id);
    await this.directory.repository.updateState(found.location, (state) => ({
      ...state,
      archived_at: archived
        ? state.archived_at ?? new Date().toISOString()
        : null,
    }));
  }

  async updateStatus(
    id: SessionId | string,
    status: FsCoderSessionStatus,
  ): Promise<void> {
    const found = await this.directory.requireEntry(id);
    await this.directory.repository.updateState(found.location, (state) => ({
      ...state,
      status,
    }));
  }

  async updateProvider(
    id: SessionId | string,
    provider: string,
    model: string,
  ): Promise<void> {
    if (!provider.trim() || !model.trim()) {
      throw new TypeError('provider and model must be non-empty');
    }
    const found = await this.directory.requireEntry(id);
    await this.directory.repository.updateSession(
      found.location,
      (session) => ({ ...session, provider, model }),
    );
  }

  async touch(id: SessionId | string): Promise<void> {
    const found = await this.directory.requireEntry(id);
    await this.directory.repository.updateSession(
      found.location,
      (session) => session,
    );
  }

  async setTodos(
    id: SessionId | string,
    todosJson: string | null,
  ): Promise<void> {
    const found = await this.directory.requireEntry(id);
    let todos: readonly JsonValue[] = [];
    if (todosJson != null) {
      const parsed = JSON.parse(todosJson) as unknown;
      if (!Array.isArray(parsed)) {
        throw new TypeError('todos_json must be an array');
      }
      todos = toJsonValue(parsed) as readonly JsonValue[];
    }
    await this.directory.repository.updateState(found.location, (state) => ({
      ...state,
      todos,
    }));
  }

  async linkProject(
    id: SessionId | string,
    input: FsLinkProjectInput,
  ): Promise<FsLinkedProject[]> {
    const canonicalRoot = await assertExistingDirectory(
      input.root_path,
      `linked project root ${String(input.project_id)}`,
    );
    return this.directory.runMutation(id, async () => {
      const found = await this.directory.requireEntry(id);
      if (found.session.storage_scope.kind !== 'global') {
        throw new TypeError('Projects can only be linked to a global session');
      }
      if (found.session.linked_projects.some(
        (project) => project.project_id === input.project_id,
      )) {
        throw new TypeError(`Project ${String(input.project_id)} is already linked`);
      }
      await this.directory.repository.updateSession(
        found.location,
        (session) => this.withLinkedProject(session, {
          ...input,
          root_path: canonicalRoot,
          is_primary: false,
          label: input.label ?? null,
        }),
      );
      return this.directory.getSessionProjects(id);
    });
  }

  async unlinkProject(
    id: SessionId | string,
    projectId: ProjectId,
  ): Promise<FsLinkedProject[]> {
    return this.directory.runMutation(id, async () => {
      const found = await this.directory.requireEntry(id);
      if (found.session.storage_scope.kind !== 'global') {
        throw new TypeError('Projects can only be unlinked from a global session');
      }
      const projects = await this.directory.getSessionProjects(id);
      const target = projects.find((project) => project.project_id === projectId);
      if (!target) {
        throw new TypeError(`Project ${String(projectId)} is not linked`);
      }
      if (target.is_primary || found.session.owner_project_id === projectId) {
        throw new TypeError('The primary project cannot be unlinked');
      }
      if (projects.length <= 1) {
        throw new TypeError('The last project cannot be unlinked');
      }
      await this.directory.repository.updateSession(
        found.location,
        (session) => {
          const coder = coderMetadata(session.metadata);
          return {
            ...session,
            linked_projects: session.linked_projects.filter(
              (project) => project.project_id !== projectId,
            ),
            metadata: {
              ...session.metadata,
              coder: toJsonValue({
                ...coder,
                linked_projects: coder.linked_projects.filter(
                  (project) => project.project_id !== projectId,
                ),
              }),
            },
          };
        },
      );
      return this.directory.getSessionProjects(id);
    });
  }

  private withLinkedProject(
    session: SessionMetadata,
    input: Required<Omit<FsLinkProjectInput, 'is_primary'>> & {
      is_primary: boolean;
    },
  ): SessionMetadata {
    const coder = coderMetadata(session.metadata);
    return {
      ...session,
      linked_projects: [
        ...session.linked_projects,
        { project_id: input.project_id, root_path: input.root_path },
      ],
      metadata: {
        ...session.metadata,
        coder: toJsonValue({
          ...coder,
          linked_projects: [
            ...coder.linked_projects,
            {
              project_id: input.project_id,
              name: input.name,
              root_path: input.root_path,
              is_primary: input.is_primary,
              label: input.label,
            },
          ],
        }),
      },
    };
  }

  async recoverStale(): Promise<number> {
    await this.directory.ensureCatalog();
    const stale = this.directory.catalog
      .list()
      .filter((entry) =>
        ['running', 'in_progress', 'working'].includes(
          entry.state?.status ?? '',
        ),
      );
    await Promise.all(
      stale.map((entry) =>
        this.directory.repository.updateState(entry.location, (state) => ({
          ...state,
          status: 'interrupted',
        })),
      ),
    );
    return stale.length;
  }

  async recoverStuck(options: { maxAgeMs?: number } = {}): Promise<number> {
    await this.directory.ensureCatalog();
    const cutoff = Date.now() - (options.maxAgeMs ?? 10 * 60 * 1_000);
    const stale = this.directory.catalog
      .list()
      .filter(
        (entry) =>
          ['running', 'in_progress', 'working'].includes(
            entry.state?.status ?? '',
          ) && Date.parse(entry.state?.updated_at ?? '') < cutoff,
      );
    await Promise.all(
      stale.map((entry) =>
        this.directory.repository.updateState(entry.location, (state) => ({
          ...state,
          status: 'interrupted',
        })),
      ),
    );
    return stale.length;
  }

  delete(id: SessionId | string): Promise<TrashResult> {
    return this.directory.runMutation(id, async () => {
      const found = await this.directory.requireEntry(id);
      return this.directory.repository.trashSession(found.location);
    });
  }

  async deleteBatch(ids: readonly (SessionId | string)[]): Promise<number> {
    return (await this.deleteBatchDetailed(ids)).length;
  }

  async deleteBatchDetailed(
    ids: readonly (SessionId | string)[],
  ): Promise<readonly TrashResult[]> {
    const results: TrashResult[] = [];
    for (const id of ids) {
      results.push(await this.delete(id));
    }
    return results;
  }

  restore(
    scope: SessionLocation['scope'],
    trashName: string,
  ): Promise<RestoreResult> {
    return this.directory.repository.restoreTrashedSession(scope, trashName);
  }

  listTrash(
    scope: SessionLocation['scope'],
  ): Promise<readonly TrashedSessionEntry[]> {
    return this.directory.repository.listTrashedSessions(scope);
  }

  getTrash(
    scope: SessionLocation['scope'],
    trashName: string,
  ): Promise<TrashedSessionEntry> {
    return this.directory.repository.getTrashedSession(scope, trashName);
  }

  purge(
    scope: SessionLocation['scope'],
    trashName: string,
  ): Promise<void> {
    return this.directory.repository.purgeTrashedSession(scope, trashName);
  }

}
