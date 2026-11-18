import {
  assertExistingDirectory,
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
  asSessionId,
  isUuid,
  type CatalogEntry,
  type ProjectId,
  type SessionId,
  type SessionLocation,
  type SessionMetadata,
} from '@mcp/session-storage';
import {
  addUsage,
  coderMetadata,
  initialCoderMetadata,
  linkedProjects,
  mapCatalogEntry,
  projectInfo,
  sortedSessions,
  type CoderMetadataProjection,
  type FsProjectInfoResolver,
} from './session-projection.js';
import { toJsonValue } from './conversation-codec.js';
import { hasStorageTrace, recordStorageElapsed, traceStorageOperation } from '../storage-timing.js';
import {
  normalizeSessionMaxAutoContinues,
  normalizeSessionMaxTurns,
} from '../run-limits.js';
import type {
  FsAppendMessageUsage,
  FsCoderSession,
  FsCreateGlobalSessionInput,
  FsCreateSessionInput,
  FsGlobalCoderSession,
  FsLinkedProject,
  FsMetricsSummary,
} from './types.js';

export interface FsSessionDirectoryOptions {
  locator: SessionLocator;
  repository?: FileSessionRepository;
  catalog?: SessionCatalog;
  writerOwnerId?: string;
  projectInfoResolver?: FsProjectInfoResolver;
}

function initialRuntimeState(
  input: Pick<
    FsCreateSessionInput,
    | 'execution_mode_override'
    | 'reasoning_effort_override'
    | 'thinking_enabled'
    | 'block_code_comments'
    | 'max_turns'
    | 'max_auto_continues'
    | 'worktree_path'
  >,
) {
  return {
    extra: {
      runtime: toJsonValue({
        worktree_path: input.worktree_path ?? null,
        max_turns: normalizeSessionMaxTurns(input.max_turns),
        max_auto_continues: normalizeSessionMaxAutoContinues(
          input.max_auto_continues,
        ),
        execution_mode_override: input.execution_mode_override ?? 'standard',
        reasoning_effort_override:
          input.reasoning_effort_override?.trim() || null,
        thinking_enabled: input.thinking_enabled === true,
        block_code_comments: input.block_code_comments !== false,
      }),
    },
  };
}

export class FsSessionDirectory {
  readonly locator: SessionLocator;
  readonly repository: FileSessionRepository;
  readonly catalog: SessionCatalog;

  private readonly projectInfoResolver?: FsProjectInfoResolver;
  private readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(options: FsSessionDirectoryOptions) {
    this.locator = options.locator;
    this.repository =
      options.repository ?? new FileSessionRepository({
        locator: this.locator,
        ...(options.writerOwnerId ? { writerOwnerId: options.writerOwnerId } : {}),
      });
    this.catalog =
      options.catalog ??
      new SessionCatalog({
        locator: this.locator,
        repository: this.repository,
      });
    this.projectInfoResolver = options.projectInfoResolver;
  }

  async ensureCatalog(): Promise<void> {
    await this.catalog.ensureReady();
  }

  async refresh(): Promise<void> {
    await this.catalog.refresh();
  }

  async entry(id: SessionId | string): Promise<CatalogEntry | null> {
    if (!isUuid(id)) return null;
    await this.ensureCatalog();
    return this.catalog.get(asSessionId(String(id)));
  }

  async requireEntry(id: SessionId | string): Promise<CatalogEntry> {
    const found = await this.entry(id);
    if (!found) throw new Error(`Unknown filesystem session ${String(id)}`);
    return found;
  }

  runMutation<T>(
    id: SessionId | string,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = String(id).toLowerCase();
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    const queuedAt = performance.now();
    const run = () => {
      recordStorageElapsed('mutation.queue', queuedAt);
      return task();
    };
    // Capture other queue owners as well as transcript commits. Stack labels
    // are collected only for an explicitly enabled diagnostic export; no
    // paths, arguments or conversation contents are included.
    const captureOwner = !!process.env.CODESTUDIO_STORAGE_TRACE_FILE && !hasStorageTrace();
    const owner = captureOwner ? new Error().stack?.split('\n').slice(2, 4)
      .map(line => line.match(/^\s*at (?:async )?([\w.$<>]+)\s+\(/)?.[1]?.slice(0, 100) ?? 'anonymous')
      .join(' > ') : undefined;
    const result = captureOwner
      ? traceStorageOperation({ sessionId: key, operationId: `mutation:${owner ?? 'unknown'}` }, () => previous.then(run, run))
      : previous.then(run, run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueues.set(key, settled);
    void settled.finally(() => {
      if (this.mutationQueues.get(key) === settled) {
        this.mutationQueues.delete(key);
      }
    });
    return result;
  }

  project(projectId: ProjectId) {
    return projectInfo(this.locator, this.projectInfoResolver, projectId);
  }

  map(entry: CatalogEntry): FsCoderSession {
    return mapCatalogEntry(
      entry,
      this.locator,
      this.repository,
      this.projectInfoResolver,
    );
  }

  async createSession(input: FsCreateSessionInput): Promise<FsCoderSession> {
    await this.ensureCatalog();
    const state = initialRuntimeState(input);
    const entry = await this.repository.createSession({
      ...(input.id ? { id: input.id } : {}),
      kind: 'coder',
      scope: { kind: 'project', project_id: input.project_id },
      owner_project_id: input.project_id,
      linked_projects: [{ project_id: input.project_id }],
      parent_session_id: input.parent_session_id ?? null,
      provider: input.provider,
      model: input.model,
      title: input.title,
      status: input.status ?? 'idle',
      state,
      metadata: initialCoderMetadata(input.metadata, {
        agent: input.agent ?? null,
        linked_projects: [
          {
            project_id: input.project_id,
            is_primary: true,
            label: null,
          },
        ],
      }),
    });
    return this.map(entry);
  }

  async createGlobalSession(
    input: FsCreateGlobalSessionInput,
  ): Promise<FsCoderSession> {
    await this.ensureCatalog();
    if (input.realProjects.length === 0) {
      throw new TypeError('A global session requires at least one linked project');
    }
    const seen = new Set<ProjectId>();
    const requestedPrimaryCount = input.realProjects.filter(
      (project) => project.isPrimary === true,
    ).length;
    if (requestedPrimaryCount > 1) {
      throw new TypeError('A global session can have only one primary project');
    }
    const linked = await Promise.all(input.realProjects.map(async (project, index) => {
      if (seen.has(project.projectId)) {
        throw new TypeError(
          `Global session project ${String(project.projectId)} is duplicated`,
        );
      }
      seen.add(project.projectId);
      const known = this.project(project.projectId);
      const rootPath = project.rootPath ?? known?.root_path;
      if (!rootPath) {
        throw new Error(
          `Linked project ${String(project.projectId)} has no registered root`,
        );
      }
      const canonicalRoot = await assertExistingDirectory(
        rootPath,
        `linked project root ${String(project.projectId)}`,
      );
      return {
        project_id: project.projectId,
        root_path: canonicalRoot,
        name: known?.name ?? String(project.projectId),
        is_primary:
          project.isPrimary === true ||
          (requestedPrimaryCount === 0 && index === 0),
        label: project.label ?? null,
      };
    }));
    const primary =
      input.owner_project_id ??
      linked.find((project) => project.is_primary)?.project_id ??
      linked[0].project_id;
    const state = initialRuntimeState(input);
    const entry = await this.repository.createSession({
      ...(input.id ? { id: input.id } : {}),
      kind: 'coder',
      scope: { kind: 'global' },
      owner_project_id: primary,
      linked_projects: linked.map((project) => ({
        project_id: project.project_id,
        root_path: project.root_path,
      })),
      parent_session_id: input.parent_session_id ?? null,
      provider: input.provider,
      model: input.model,
      title: input.title,
      status: input.status ?? 'idle',
      state,
      metadata: initialCoderMetadata(input.metadata, {
        agent: input.agent ?? null,
        linked_projects: linked,
      }),
    });
    return this.map(entry);
  }

  async getSession(id: SessionId | string): Promise<FsCoderSession | null> {
    const found = await this.entry(id);
    return found ? this.map(found) : null;
  }

  async refreshSession(id: SessionId | string): Promise<FsCoderSession | null> {
    const found = await this.entry(id);
    if (!found) return null;
    await this.repository.refreshSessionProjectionAsync(found.location);
    const refreshed = this.catalog.get(found.session.id);
    return refreshed ? this.map(refreshed) : null;
  }

  async getLastUsedProviderModel(): Promise<{
    provider: string;
    model: string;
  } | null> {
    await this.ensureCatalog();
    // The catalog is already ordered by the session projection's updated_at.
    // Do not map every session here: mapCatalogEntry also reads each bundle's
    // metrics summary synchronously, so a single click on a project in a slow
    // volume used to block on every session across every known project.
    const found = this.catalog.list().find(
      (entry) =>
        entry.session.kind === 'coder' &&
        (entry.session.provider?.trim().length ?? 0) > 0 &&
        (entry.session.model?.trim().length ?? 0) > 0,
    );
    const provider = found?.session.provider;
    const model = found?.session.model;
    return provider && model ? { provider, model } : null;
  }

  async listSessions(
    projectId: ProjectId,
    options: {
      archived?: boolean | null;
      groupId?: string | null;
    } = {},
  ): Promise<FsCoderSession[]> {
    await this.ensureCatalog();
    const archived = options.archived === undefined ? false : options.archived;
    return sortedSessions(
      this.catalog
        .list()
        .filter(
          (entry) =>
            entry.session.kind === 'coder' &&
            entry.session.storage_scope.kind === 'project' &&
            entry.session.storage_scope.project_id === projectId,
        )
        .map((entry) => this.map(entry))
        .filter(
          (session) =>
            archived === null || session.is_archived === archived,
        )
        .filter(
          (session) =>
            options.groupId === undefined ||
            session.group_id === options.groupId,
        ),
    );
  }

  async listGlobalSessions(
    options: { archived?: boolean | null } = {},
  ): Promise<FsGlobalCoderSession[]> {
    await this.ensureCatalog();
    const archived = options.archived === undefined ? false : options.archived;
    return sortedSessions(
      this.catalog
        .list()
        .filter(
          (entry) =>
            entry.session.kind === 'coder' &&
            entry.session.storage_scope.kind === 'global',
        )
        .map((entry) => this.map(entry))
        .filter(
          (session) =>
            archived === null || session.is_archived === archived,
        ),
    ).map((session) => {
      const primary =
        session.linked_projects.find((project) => project.is_primary) ??
        session.linked_projects[0];
      return {
        ...session,
        project_name: primary?.name ?? '',
        linked_count: session.linked_projects.length,
        workspace_label: session.linked_projects
          .map((project) => project.name)
          .join(' + '),
      };
    });
  }

  async getSessionProjects(
    id: SessionId | string,
  ): Promise<FsLinkedProject[]> {
    return linkedProjects(
      await this.requireEntry(id),
      this.locator,
      this.projectInfoResolver,
    );
  }

  async countSessionsForProject(projectId: ProjectId): Promise<number> {
    await this.ensureCatalog();
    return this.catalog
      .list()
      .filter(
        (entry) =>
          entry.session.owner_project_id === projectId ||
          entry.session.linked_projects.some(
            (project) => project.project_id === projectId,
          ),
      ).length;
  }

  async updateCoderMetadata(
    location: SessionLocation,
    update: (
      current: CoderMetadataProjection,
    ) => CoderMetadataProjection,
  ): Promise<SessionMetadata> {
    return this.repository.updateSession(location, (session) => ({
      ...session,
      metadata: {
        ...session.metadata,
        coder: toJsonValue(update(coderMetadata(session.metadata))),
      },
    }));
  }

  async bumpUsage(
    location: SessionLocation,
    ...usages: Array<FsAppendMessageUsage | null | undefined>
  ): Promise<void> {
    await this.updateCoderMetadata(location, (current) => ({
      ...current,
      usage: usages.reduce(addUsage, current.usage),
    }));
  }

  async getMetricsSummary(
    id: SessionId | string,
  ): Promise<FsMetricsSummary> {
    const entry = await this.requireEntry(id);
    return this.repository.readMetricsSummarySync(entry.location);
  }

  rebuildMetricsSummary(
    id: SessionId | string,
  ): Promise<FsMetricsSummary> {
    return this.runMutation(id, async () => {
      const entry = await this.requireEntry(id);
      return this.repository.rebuildMetricsSummary(entry.location);
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.mutationQueues.values()]);
    this.mutationQueues.clear();
    this.catalog.close();
    await this.repository.close();
  }
}
