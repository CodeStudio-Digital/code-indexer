/** App Studio v6 filesystem control-plane store. */
import {
  EntityFileRepository,
  asSessionId,
  assertExistingDirectory,
  isUuid,
  newSessionId,
  type CatalogEntry,
  type CompanySessionId,
  type EntityRecord,
  type FileSessionRepository,
  type JsonValue,
  type ProjectId,
  type SessionCatalog,
  type SessionId,
  type SessionLocation,
  type SessionLocator,
  type SessionMetadata,
} from '@mcp/session-storage';
import type {
  AppFitnessReport,
  AppPlanRevisionStatus,
  AppPlanV1,
} from '@mcp/app-studio/plan/types.js';

export type AppStudioWorkItemStatus =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'review'
  | 'done'
  | 'blocked'
  | 'stale'
  | 'cancelled';
export type AppStudioWorkItemKind =
  | 'research'
  | 'plan'
  | 'contract'
  | 'implement'
  | 'verify'
  | 'release'
  | 'change';
export type AppStudioWorkItemRunStatus =
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'error'
  | 'aborted'
  | 'interrupted'
  | 'cancelled';

export interface AppStudioSession {
  id: SessionId;
  seq: number;
  project_id: ProjectId;
  company_session_id: CompanySessionId | null;
  name: string;
  app_slug: string;
  stack_profile_id: 'cf-fullstack-v1';
  created_at: string;
  updated_at: string;
}

export interface CreateAppStudioSessionInput {
  project_id: ProjectId;
  name: string;
  app_slug: string;
}

export interface AppStudioPlanRevision {
  id: string;
  seq: number;
  app_session_id: SessionId;
  revision_number: number;
  status: AppPlanRevisionStatus;
  plan_json: string;
  fitness_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

export interface SaveAppStudioPlanRevisionInput {
  app_session_id: SessionId | string;
  plan: AppPlanV1;
  fitness: AppFitnessReport;
  created_by?: string;
  expected_revision_number?: number | null;
}

export interface AppStudioWorkItem {
  app_session_id: SessionId;
  id: string;
  seq: number;
  source_id: string;
  plan_revision_id: string;
  slice_id: string | null;
  title: string;
  outcome: string;
  kind: AppStudioWorkItemKind;
  owner_role: string;
  priority: number;
  status: AppStudioWorkItemStatus;
  sort_order: number;
  depends_on_json: string;
  source_ids_json: string;
  acceptance_json: string;
  evidence_json: string;
  file_scope_json: string;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertAppStudioWorkItemInput {
  app_session_id: SessionId | string;
  /** Stable plan-local identifier. The persisted/public id is a UUID. */
  id: string;
  plan_revision_id: string;
  slice_id?: string | null;
  title: string;
  outcome?: string;
  kind: AppStudioWorkItemKind;
  owner_role: string;
  priority?: number;
  status?: AppStudioWorkItemStatus;
  sort_order?: number;
  depends_on_json?: string;
  source_ids_json?: string;
  acceptance_json?: string;
  evidence_json?: string;
  file_scope_json?: string;
  blocked_reason?: string | null;
}

export interface AppStudioWorkItemRun {
  id: string;
  seq: number;
  app_session_id: SessionId;
  work_item_id: string;
  attempt: number;
  role: string;
  company_agent_run_id: string | null;
  coder_session_id: SessionId | null;
  status: AppStudioWorkItemRunStatus;
  runtime_config_hash: string | null;
  idempotency_key: string;
  status_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface CreateAppStudioWorkItemRunInput {
  appSessionId: SessionId | string;
  workItemId: string;
  attempt: number;
  role: string;
  companyAgentRunId?: string | null;
  coderSessionId?: SessionId | string | null;
  status?: AppStudioWorkItemRunStatus;
  runtimeConfigHash?: string | null;
  idempotencyKey?: string;
}

export interface UpdateAppStudioWorkItemRunOptions {
  companyAgentRunId?: string | null;
  coderSessionId?: SessionId | string | null;
  runtimeConfigHash?: string | null;
  statusMessage?: string | null;
}

export interface AppStudioDecision {
  id: string;
  seq: number;
  app_session_id: SessionId;
  plan_revision_id: string;
  question: string;
  options_json: string;
  blocked_work_item_ids_json: string;
  status: 'open' | 'resolved';
  answer: string | null;
  requested_at: string;
  resolved_at: string | null;
}

export interface AppStudioEvent {
  id: string;
  seq: number;
  app_session_id: SessionId;
  kind: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  idempotency_key: string | null;
  created_at: string;
}

export interface AppStudioDeployment {
  id: string;
  seq: number;
  app_session_id: SessionId;
  plan_revision_id: string;
  status: 'publishing' | 'live' | 'failed';
  url: string | null;
  account: string | null;
  database_id: string | null;
  health_ok: number;
  details_json: string;
  created_at: string;
  updated_at: string;
}

export interface AppStudioStoreHost {
  repository: FileSessionRepository & {
    runExclusive<T>(
      location: SessionLocation,
      operation: () => Promise<T>,
    ): Promise<T>;
  };
  catalog: SessionCatalog;
  locator: SessionLocator;
  getProject(projectId: ProjectId): {
    id: ProjectId;
    root_path: string;
  } | null;
}

interface AppStudioMetadata {
  seq: number;
  project_id: ProjectId;
  company_session_id: string | null;
  name: string;
  app_slug: string;
  stack_profile_id: 'cf-fullstack-v1';
}

interface PlanRevisionData {
  revision_number: number;
  status: AppPlanRevisionStatus;
  plan_json: string;
  fitness_json: string;
  created_by: string;
  approved_at: string | null;
}

interface WorkItemData {
  source_id: string;
  plan_revision_id: string;
  slice_id: string | null;
  title: string;
  outcome: string;
  kind: AppStudioWorkItemKind;
  owner_role: string;
  priority: number;
  status: AppStudioWorkItemStatus;
  sort_order: number;
  depends_on_json: string;
  source_ids_json: string;
  acceptance_json: string;
  evidence_json: string;
  file_scope_json: string;
  blocked_reason: string | null;
}

interface WorkItemRunData {
  work_item_id: string;
  attempt: number;
  role: string;
  company_agent_run_id: string | null;
  coder_session_id: string | null;
  status: AppStudioWorkItemRunStatus;
  runtime_config_hash: string | null;
  idempotency_key: string;
  status_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface DecisionData {
  plan_revision_id: string;
  question: string;
  options_json: string;
  blocked_work_item_ids_json: string;
  status: 'open' | 'resolved';
  answer: string | null;
  requested_at: string;
  resolved_at: string | null;
}

interface EventData {
  kind: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  idempotency_key: string | null;
}

interface DeploymentData {
  plan_revision_id: string;
  status: AppStudioDeployment['status'];
  url: string | null;
  account: string | null;
  database_id: string | null;
  health_ok: number;
  details_json: string;
}

type AppEntry = CatalogEntry & { session: SessionMetadata };

const TERMINAL_RUN_STATUSES = new Set<AppStudioWorkItemRunStatus>([
  'completed',
  'blocked',
  'error',
  'aborted',
  'interrupted',
  'cancelled',
]);

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function parseStringArray(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${label} must be a JSON string array`);
  }
  return parsed;
}

function appMetadata(session: SessionMetadata): AppStudioMetadata | null {
  const raw = objectValue(session.metadata.app_studio);
  if (
    !Number.isSafeInteger(raw.seq) ||
    typeof raw.project_id !== 'number' ||
    typeof raw.name !== 'string' ||
    typeof raw.app_slug !== 'string'
  ) {
    return null;
  }
  return {
    seq: raw.seq as number,
    project_id: raw.project_id as ProjectId,
    company_session_id:
      typeof raw.company_session_id === 'string'
        ? raw.company_session_id
        : null,
    name: raw.name,
    app_slug: raw.app_slug,
    stack_profile_id: 'cf-fullstack-v1',
  };
}

/**
 * No database handle is accepted. Every operational record is an independent
 * atomic JSON entity inside the App Studio global session bundle.
 */
export class AppStudioStore {
  readonly #host: AppStudioStoreHost;
  readonly #entityRepositories = new Map<string, EntityFileRepository<object>>();
  #readyPromise: Promise<void> | null = null;

  constructor(host: AppStudioStoreHost) {
    this.#host = host;
  }

  async #ready(): Promise<void> {
    this.#readyPromise ??= this.#host.catalog.refresh().then(() => undefined);
    await this.#readyPromise;
  }

  #appEntries(): AppEntry[] {
    return this.#host.catalog
      .list()
      .filter(
        (entry): entry is AppEntry =>
          entry.session.kind === 'app_studio' &&
          appMetadata(entry.session) != null,
      );
  }

  async #entry(id: SessionId | string): Promise<AppEntry | null> {
    await this.#ready();
    const entry = this.#host.catalog.get(String(id));
    if (
      !entry ||
      entry.session.kind !== 'app_studio' ||
      appMetadata(entry.session) == null
    ) {
      return null;
    }
    await this.#host.locator.assertSafeLocation(entry.location, {
      mustExist: true,
    });
    return entry as AppEntry;
  }

  async #requireEntry(id: SessionId | string): Promise<AppEntry> {
    const entry = await this.#entry(id);
    if (!entry) throw new Error(`App Studio session ${String(id)} not found`);
    return entry;
  }

  #repo<T extends object>(
    entry: AppEntry,
    namespace: string,
    kind: string,
  ): EntityFileRepository<T> {
    const key = `${entry.location.bundle_path}\0${namespace}`;
    let repository = this.#entityRepositories.get(key);
    if (!repository) {
      repository = new EntityFileRepository({
        sessionRoot: entry.location.bundle_path,
        namespace: `company/app-studio/${namespace}`,
        kind: `app_studio_${kind}`,
        journal: true,
      }) as EntityFileRepository<object>;
      this.#entityRepositories.set(key, repository);
    }
    return repository as EntityFileRepository<T>;
  }

  #session(entry: AppEntry): AppStudioSession {
    const app = appMetadata(entry.session)!;
    return {
      id: entry.session.id,
      seq: app.seq,
      project_id: app.project_id,
      company_session_id:
        app.company_session_id as CompanySessionId | null,
      name: app.name,
      app_slug: app.app_slug,
      stack_profile_id: app.stack_profile_id,
      created_at: entry.session.created_at,
      updated_at: entry.session.updated_at,
    };
  }

  async close(): Promise<void> {
    this.#entityRepositories.clear();
  }

  async createSession(
    input: CreateAppStudioSessionInput,
  ): Promise<AppStudioSession> {
    await this.#ready();
    if ((await this.getSessionByProjectId(input.project_id)) != null) {
      throw new Error(`Project ${input.project_id} already has an App Studio session`);
    }
    const project = this.#host.getProject(input.project_id);
    if (!project) throw new Error(`Project ${input.project_id} is not registered`);
    const root = await assertExistingDirectory(
      project.root_path,
      `App Studio project root ${input.project_id}`,
    );
    const seq =
      this.#appEntries().reduce(
        (max, entry) => Math.max(max, appMetadata(entry.session)!.seq),
        0,
      ) + 1;
    const app: AppStudioMetadata = {
      seq,
      project_id: input.project_id,
      company_session_id: null,
      name: input.name.trim(),
      app_slug: input.app_slug.trim(),
      stack_profile_id: 'cf-fullstack-v1',
    };
    if (!app.name || !app.app_slug) {
      throw new TypeError('App Studio name and app_slug are required');
    }
    const entry = await this.#host.repository.createSession({
      kind: 'app_studio',
      scope: { kind: 'global' },
      owner_project_id: input.project_id,
      linked_projects: [
        { project_id: input.project_id, root_path: root },
      ],
      title: app.name,
      status: 'idle',
      metadata: { app_studio: app } as unknown as Record<string, JsonValue>,
    });
    return this.#session(entry as AppEntry);
  }

  async getSession(
    id: SessionId | string,
  ): Promise<AppStudioSession | null> {
    const entry = await this.#entry(id);
    return entry ? this.#session(entry) : null;
  }

  async getSessionByProjectId(
    projectId: ProjectId,
  ): Promise<AppStudioSession | null> {
    await this.#ready();
    const entry = this.#appEntries().find(
      (candidate) => appMetadata(candidate.session)!.project_id === projectId,
    );
    return entry ? this.#session(entry) : null;
  }

  async getSessionByCompanySessionId(
    companySessionId: CompanySessionId | string,
  ): Promise<AppStudioSession | null> {
    await this.#ready();
    const id = String(companySessionId);
    const entry = this.#appEntries().find(
      (candidate) =>
        appMetadata(candidate.session)!.company_session_id === id,
    );
    return entry ? this.#session(entry) : null;
  }

  async listSessions(): Promise<AppStudioSession[]> {
    await this.#ready();
    return this.#appEntries()
      .map((entry) => this.#session(entry))
      .sort(
        (left, right) =>
          Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
          right.seq - left.seq,
      );
  }

  async setCompanySessionId(
    id: SessionId | string,
    companySessionId: CompanySessionId | string,
  ): Promise<AppStudioSession> {
    const entry = await this.#requireEntry(id);
    const company = this.#host.catalog.get(String(companySessionId));
    if (
      !company ||
      !['company', 'app_studio'].includes(company.session.kind)
    ) {
      throw new Error(`Company session ${String(companySessionId)} not found`);
    }
    const session = await this.#host.repository.updateSession(
      entry.location,
      (current) => {
        const app = appMetadata(current)!;
        return {
          ...current,
          metadata: {
            ...current.metadata,
            app_studio: {
              ...app,
              company_session_id: String(companySessionId),
            },
          },
        } as SessionMetadata;
      },
    );
    return this.#session({ ...entry, session });
  }

  async deleteSession(id: SessionId | string): Promise<void> {
    const entry = await this.#requireEntry(id);
    await this.#host.repository.trashSession(entry.location);
  }

  #planRow(
    entry: AppEntry,
    record: EntityRecord<PlanRevisionData>,
  ): AppStudioPlanRevision {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  async listPlanRevisions(
    sessionId: SessionId | string,
  ): Promise<AppStudioPlanRevision[]> {
    const entry = await this.#requireEntry(sessionId);
    const page = await this.#repo<PlanRevisionData>(
      entry,
      'plan-revisions',
      'plan_revision',
    ).list({ limit: 1_000, order: 'desc' });
    return page.items.map((record) => this.#planRow(entry, record));
  }

  async getPlanRevision(id: string): Promise<AppStudioPlanRevision | null> {
    if (!isUuid(id)) return null;
    await this.#ready();
    for (const entry of this.#appEntries()) {
      const record = await this.#repo<PlanRevisionData>(
        entry,
        'plan-revisions',
        'plan_revision',
      ).get(id);
      if (record) return this.#planRow(entry, record);
    }
    return null;
  }

  async getLatestPlanRevision(
    sessionId: SessionId | string,
  ): Promise<AppStudioPlanRevision | null> {
    return (await this.listPlanRevisions(sessionId))[0] ?? null;
  }

  async getLatestApprovedPlanRevision(
    sessionId: SessionId | string,
  ): Promise<AppStudioPlanRevision | null> {
    return (
      (await this.listPlanRevisions(sessionId)).find(
        (revision) => revision.status === 'approved',
      ) ?? null
    );
  }

  async #appendEventRecord(
    entry: AppEntry,
    kind: string,
    entityType: string,
    entityId: string,
    payloadJson: string,
    idempotencyKey: string | null,
  ): Promise<AppStudioEvent> {
    JSON.parse(payloadJson);
    const repository = this.#repo<EventData>(entry, 'events', 'event');
    if (idempotencyKey) {
      const existing = (
        await repository.list({ limit: 1_000, order: 'desc' })
      ).items.find(
        (record) => record.data.idempotency_key === idempotencyKey,
      );
      if (existing) return this.#eventRow(entry, existing);
    }
    const record = await repository.create({
      data: {
        kind,
        entity_type: entityType,
        entity_id: entityId,
        payload_json: payloadJson,
        idempotency_key: idempotencyKey,
      },
    });
    return this.#eventRow(entry, record);
  }

  async savePlanRevision(
    input: SaveAppStudioPlanRevisionInput,
  ): Promise<AppStudioPlanRevision> {
    const entry = await this.#requireEntry(input.app_session_id);
    return this.#host.repository.runExclusive(entry.location, async () => {
      const plans = this.#repo<PlanRevisionData>(
        entry,
        'plan-revisions',
        'plan_revision',
      );
      const revisions = (
        await plans.list({ limit: 1_000, order: 'desc' })
      ).items;
      const latest = revisions[0];
      if (
        input.expected_revision_number != null &&
        latest?.data.revision_number !== input.expected_revision_number
      ) {
        throw new Error(
          `App plan changed (expected r${input.expected_revision_number}, current r${latest?.data.revision_number ?? 0})`,
        );
      }
      for (const revision of revisions) {
        if (revision.data.status !== 'draft') continue;
        await plans.update(revision.id, {
          data: { ...revision.data, status: 'superseded' },
        });
      }
      const work = this.#repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      for (const item of (
        await work.list({ limit: 1_000 })
      ).items) {
        if (['cancelled', 'stale'].includes(item.data.status)) continue;
        await work.update(item.id, {
          data: {
            ...item.data,
            status: 'stale',
            blocked_reason:
              'The App plan changed; regenerate this card from the current revision.',
          },
        });
      }
      const next = (latest?.data.revision_number ?? 0) + 1;
      const created = await plans.create({
        data: {
          revision_number: next,
          status: 'draft',
          plan_json: JSON.stringify(input.plan),
          fitness_json: JSON.stringify(input.fitness),
          created_by: input.created_by ?? 'app_orchestrator',
          approved_at: null,
        },
      });
      await this.#appendEventRecord(
        entry,
        'plan.revised',
        'plan_revision',
        created.id,
        JSON.stringify({
          revision_number: next,
          fitness: input.fitness.status,
        }),
        null,
      );
      return this.#planRow(entry, created);
    });
  }

  async approvePlanRevision(
    sessionId: SessionId | string,
    revisionId: string,
  ): Promise<AppStudioPlanRevision> {
    const entry = await this.#requireEntry(sessionId);
    return this.#host.repository.runExclusive(entry.location, async () => {
      const repository = this.#repo<PlanRevisionData>(
        entry,
        'plan-revisions',
        'plan_revision',
      );
      const revision = await repository.get(revisionId);
      if (!revision) throw new Error('App plan revision not found');
      const fitness = JSON.parse(
        revision.data.fitness_json,
      ) as AppFitnessReport;
      if (fitness.status !== 'ready') {
        throw new Error('Only a ready App plan can be approved');
      }
      for (const item of (
        await repository.list({ limit: 1_000 })
      ).items) {
        if (item.data.status !== 'approved') continue;
        await repository.update(item.id, {
          data: { ...item.data, status: 'superseded' },
        });
      }
      const now = new Date().toISOString();
      const approved = await repository.update(revision.id, {
        data: {
          ...revision.data,
          status: 'approved',
          approved_at: now,
        },
      });
      await this.#appendEventRecord(
        entry,
        'plan.approved',
        'plan_revision',
        revision.id,
        JSON.stringify({ revision_number: revision.data.revision_number }),
        `plan-approved:${revision.id}`,
      );
      return this.#planRow(entry, approved);
    });
  }

  #workRow(
    entry: AppEntry,
    record: EntityRecord<WorkItemData>,
  ): AppStudioWorkItem {
    return {
      app_session_id: entry.session.id,
      id: record.id,
      seq: record.seq,
      ...record.data,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  async listWorkItems(
    sessionId: SessionId | string,
  ): Promise<AppStudioWorkItem[]> {
    const entry = await this.#requireEntry(sessionId);
    const records = (
      await this.#repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      ).list({ limit: 1_000 })
    ).items;
    return records
      .map((record) => this.#workRow(entry, record))
      .sort(
        (left, right) =>
          left.sort_order - right.sort_order ||
          right.priority - left.priority ||
          left.seq - right.seq,
      );
  }

  async getWorkItem(
    sessionId: SessionId | string,
    id: string,
  ): Promise<AppStudioWorkItem | null> {
    const entry = await this.#requireEntry(sessionId);
    const repository = this.#repo<WorkItemData>(
      entry,
      'work-items',
      'work_item',
    );
    const direct = isUuid(id) ? await repository.get(id) : null;
    const record =
      direct ??
      (
        await repository.list({ limit: 1_000 })
      ).items.find((candidate) => candidate.data.source_id === id);
    return record ? this.#workRow(entry, record) : null;
  }

  async upsertWorkItems(
    items: UpsertAppStudioWorkItemInput[],
  ): Promise<AppStudioWorkItem[]> {
    if (items.length === 0) return [];
    const sessionId = String(items[0].app_session_id);
    if (items.some((item) => String(item.app_session_id) !== sessionId)) {
      throw new TypeError('App work item batches cannot cross sessions');
    }
    const entry = await this.#requireEntry(sessionId);
    return this.#host.repository.runExclusive(entry.location, async () => {
      const repository = this.#repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      const existing = (
        await repository.list({ limit: 1_000 })
      ).items;
      const bySource = new Map(
        existing.map((record) => [record.data.source_id, record]),
      );
      const publicIds = new Map<string, string>();
      for (const item of items) {
        publicIds.set(
          item.id,
          bySource.get(item.id)?.id ??
            (isUuid(item.id) && existing.some((record) => record.id === item.id)
              ? item.id
              : String(newSessionId())),
        );
      }
      const output: AppStudioWorkItem[] = [];
      for (const input of items) {
        const previous =
          bySource.get(input.id) ??
          existing.find((record) => record.id === input.id);
        const dependencies = parseStringArray(
          input.depends_on_json ?? '[]',
          'depends_on_json',
        ).map((dependency) => publicIds.get(dependency) ?? dependency);
        if (dependencies.some((dependency) => !isUuid(dependency))) {
          throw new TypeError(
            `Unknown App work item dependency in '${input.id}'`,
          );
        }
        const data: WorkItemData = {
          source_id: previous?.data.source_id ?? input.id,
          plan_revision_id: input.plan_revision_id,
          slice_id: input.slice_id ?? null,
          title: input.title,
          outcome: input.outcome ?? '',
          kind: input.kind,
          owner_role: input.owner_role,
          priority: input.priority ?? 0,
          status: input.status ?? 'backlog',
          sort_order: input.sort_order ?? 0,
          depends_on_json: JSON.stringify(dependencies),
          source_ids_json: input.source_ids_json ?? '[]',
          acceptance_json: input.acceptance_json ?? '[]',
          evidence_json: input.evidence_json ?? '[]',
          file_scope_json: input.file_scope_json ?? '[]',
          blocked_reason: input.blocked_reason ?? null,
        };
        JSON.parse(data.source_ids_json);
        JSON.parse(data.acceptance_json);
        JSON.parse(data.evidence_json);
        JSON.parse(data.file_scope_json);
        const record = previous
          ? await repository.update(previous.id, { data })
          : await repository.create({
              id: publicIds.get(input.id),
              relations: { plan_revision: input.plan_revision_id },
              data,
            });
        output.push(this.#workRow(entry, record));
      }
      return output;
    });
  }

  async setWorkItemStatus(
    sessionId: SessionId | string,
    id: string,
    status: AppStudioWorkItemStatus,
    options: {
      blockedReason?: string | null;
      evidenceJson?: string;
    } = {},
  ): Promise<AppStudioWorkItem> {
    const entry = await this.#requireEntry(sessionId);
    return this.#host.repository.runExclusive(entry.location, async () => {
      const current = await this.getWorkItem(sessionId, id);
      if (!current) throw new Error(`App work item '${id}' not found`);
      if (options.evidenceJson != null) JSON.parse(options.evidenceJson);
      const repository = this.#repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      const record = await repository.update(current.id, {
        data: {
          source_id: current.source_id,
          plan_revision_id: current.plan_revision_id,
          slice_id: current.slice_id,
          title: current.title,
          outcome: current.outcome,
          kind: current.kind,
          owner_role: current.owner_role,
          priority: current.priority,
          status,
          sort_order: current.sort_order,
          depends_on_json: current.depends_on_json,
          source_ids_json: current.source_ids_json,
          acceptance_json: current.acceptance_json,
          evidence_json: options.evidenceJson ?? current.evidence_json,
          file_scope_json: current.file_scope_json,
          blocked_reason:
            options.blockedReason === undefined
              ? current.blocked_reason
              : options.blockedReason,
        },
      });
      await this.#appendEventRecord(
        entry,
        'work.status',
        'work_item',
        current.id,
        JSON.stringify({
          status,
          blocked_reason: options.blockedReason ?? null,
        }),
        null,
      );
      return this.#workRow(entry, record);
    });
  }

  async markWorkItemsStale(
    sessionId: SessionId | string,
    ids: string[],
    reason: string,
  ): Promise<number> {
    const entry = await this.#requireEntry(sessionId);
    return this.#host.repository.runExclusive(entry.location, async () => {
      let changed = 0;
      const repository = this.#repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      for (const id of ids) {
        const current = await this.getWorkItem(sessionId, id);
        if (!current || current.status === 'cancelled') continue;
        const record = await repository.require(current.id);
        await repository.update(record.id, {
          data: {
            ...record.data,
            status: 'stale',
            blocked_reason: reason,
          },
        });
        changed += 1;
      }
      return changed;
    });
  }

  async refreshReadyWorkItems(
    sessionId: SessionId | string,
  ): Promise<AppStudioWorkItem[]> {
    const entry = await this.#requireEntry(sessionId);
    const approved = await this.getLatestApprovedPlanRevision(sessionId);
    if (!approved) return this.listWorkItems(sessionId);
    await this.#host.repository.runExclusive(entry.location, async () => {
      const items = await this.listWorkItems(sessionId);
      const done = new Set(
        items.filter((item) => item.status === 'done').map((item) => item.id),
      );
      const review = new Set(
        items.filter((item) => item.status === 'review').map((item) => item.id),
      );
      const repository = this.#repo<WorkItemData>(
        entry,
        'work-items',
        'work_item',
      );
      for (const item of items) {
        if (
          item.plan_revision_id !== approved.id ||
          item.status !== 'backlog'
        ) {
          continue;
        }
        const dependencies = parseStringArray(
          item.depends_on_json,
          'depends_on_json',
        );
        const ready =
          item.kind === 'verify'
            ? dependencies.every(
                (dependency) =>
                  done.has(dependency) || review.has(dependency),
              )
            : dependencies.every((dependency) => done.has(dependency));
        if (!ready) continue;
        const record = await repository.require(item.id);
        await repository.update(record.id, {
          data: { ...record.data, status: 'ready' },
        });
      }
    });
    return this.listWorkItems(sessionId);
  }

  #runRow(
    entry: AppEntry,
    record: EntityRecord<WorkItemRunData>,
  ): AppStudioWorkItemRun {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
      coder_session_id: record.data.coder_session_id == null
        ? null
        : asSessionId(String(record.data.coder_session_id)),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  async nextWorkItemRunAttempt(
    sessionId: SessionId | string,
    workItemId: string,
  ): Promise<number> {
    const runs = await this.listWorkItemRuns(sessionId, { workItemId });
    return runs.reduce((max, run) => Math.max(max, run.attempt), 0) + 1;
  }

  async createWorkItemRun(
    input: CreateAppStudioWorkItemRunInput,
  ): Promise<AppStudioWorkItemRun> {
    const entry = await this.#requireEntry(input.appSessionId);
    const workItem = await this.getWorkItem(
      input.appSessionId,
      input.workItemId,
    );
    if (!workItem) {
      throw new Error(`App work item '${input.workItemId}' not found`);
    }
    return this.#host.repository.runExclusive(entry.location, async () => {
      const repository = this.#repo<WorkItemRunData>(
        entry,
        'work-item-runs',
        'work_item_run',
      );
      const key =
        input.idempotencyKey ??
        `app:${String(input.appSessionId)}:work:${workItem.id}:attempt:${input.attempt}`;
      const existing = (
        await repository.list({ limit: 1_000, order: 'desc' })
      ).items.find((record) => record.data.idempotency_key === key);
      if (existing) return this.#runRow(entry, existing);
      const status = input.status ?? 'claimed';
      const now = new Date().toISOString();
      const record = await repository.create({
        relations: {
          work_item: workItem.id,
          ...(input.companyAgentRunId
            ? { company_agent_run: input.companyAgentRunId }
            : {}),
          ...(input.coderSessionId
            ? { coder_session: String(input.coderSessionId) }
            : {}),
        },
        data: {
          work_item_id: workItem.id,
          attempt: input.attempt,
          role: input.role,
          company_agent_run_id: input.companyAgentRunId ?? null,
          coder_session_id:
            input.coderSessionId == null
              ? null
              : String(input.coderSessionId),
          status,
          runtime_config_hash: input.runtimeConfigHash ?? null,
          idempotency_key: key,
          status_message: null,
          started_at: ['running', 'waiting'].includes(status) ? now : null,
          completed_at: null,
        },
      });
      return this.#runRow(entry, record);
    });
  }

  async getActiveWorkItemRun(
    sessionId: SessionId | string,
    workItemId: string,
  ): Promise<AppStudioWorkItemRun | null> {
    return (
      (await this.listWorkItemRuns(sessionId, { workItemId })).find((run) =>
        ['claimed', 'running', 'waiting', 'paused'].includes(run.status),
      ) ?? null
    );
  }

  async listWorkItemRuns(
    sessionId: SessionId | string,
    options: { workItemId?: string; limit?: number } = {},
  ): Promise<AppStudioWorkItemRun[]> {
    const entry = await this.#requireEntry(sessionId);
    const workItem = options.workItemId
      ? await this.getWorkItem(sessionId, options.workItemId)
      : null;
    if (options.workItemId && !workItem) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 250, 1_000));
    const records = (
      await this.#repo<WorkItemRunData>(
        entry,
        'work-item-runs',
        'work_item_run',
      ).list({ limit: 1_000, order: 'desc' })
    ).items.filter(
      (record) =>
        !workItem || record.data.work_item_id === workItem.id,
    );
    return records
      .slice(0, limit)
      .map((record) => this.#runRow(entry, record));
  }

  async updateWorkItemRunStatus(
    id: string,
    status: AppStudioWorkItemRunStatus,
    options: UpdateAppStudioWorkItemRunOptions = {},
  ): Promise<AppStudioWorkItemRun> {
    if (!isUuid(id)) throw new TypeError('App work item run id must be a UUID');
    await this.#ready();
    for (const entry of this.#appEntries()) {
      const repository = this.#repo<WorkItemRunData>(
        entry,
        'work-item-runs',
        'work_item_run',
      );
      const current = await repository.get(id);
      if (!current) continue;
      return this.#host.repository.runExclusive(entry.location, async () => {
        const now = new Date().toISOString();
        const next = await repository.update(id, {
          data: {
            ...current.data,
            status,
            company_agent_run_id:
              options.companyAgentRunId ??
              current.data.company_agent_run_id,
            coder_session_id:
              options.coderSessionId === undefined
                ? current.data.coder_session_id
                : options.coderSessionId == null
                  ? null
                  : String(options.coderSessionId),
            runtime_config_hash:
              options.runtimeConfigHash ??
              current.data.runtime_config_hash,
            status_message:
              options.statusMessage ?? current.data.status_message,
            started_at:
              ['running', 'waiting'].includes(status)
                ? current.data.started_at ?? now
                : current.data.started_at,
            completed_at: TERMINAL_RUN_STATUSES.has(status)
              ? now
              : current.data.completed_at,
          },
        });
        return this.#runRow(entry, next);
      });
    }
    throw new Error(`App work item run ${id} not found`);
  }

  #decisionRow(
    entry: AppEntry,
    record: EntityRecord<DecisionData>,
  ): AppStudioDecision {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
    };
  }

  async listDecisions(
    sessionId: SessionId | string,
  ): Promise<AppStudioDecision[]> {
    const entry = await this.#requireEntry(sessionId);
    const records = (
      await this.#repo<DecisionData>(
        entry,
        'decisions',
        'decision',
      ).list({ limit: 1_000, order: 'desc' })
    ).items;
    return records.map((record) => this.#decisionRow(entry, record));
  }

  async createDecision(input: {
    sessionId: SessionId | string;
    planRevisionId: string;
    question: string;
    optionsJson?: string;
    blockedWorkItemIdsJson?: string;
  }): Promise<AppStudioDecision> {
    const entry = await this.#requireEntry(input.sessionId);
    const optionsJson = input.optionsJson ?? '[]';
    const blockedJson = input.blockedWorkItemIdsJson ?? '[]';
    JSON.parse(optionsJson);
    JSON.parse(blockedJson);
    return this.#host.repository.runExclusive(entry.location, async () => {
      const requested = new Date().toISOString();
      const record = await this.#repo<DecisionData>(
        entry,
        'decisions',
        'decision',
      ).create({
        relations: { plan_revision: input.planRevisionId },
        data: {
          plan_revision_id: input.planRevisionId,
          question: input.question,
          options_json: optionsJson,
          blocked_work_item_ids_json: blockedJson,
          status: 'open',
          answer: null,
          requested_at: requested,
          resolved_at: null,
        },
      });
      await this.#appendEventRecord(
        entry,
        'decision.requested',
        'decision',
        record.id,
        JSON.stringify({ question: input.question }),
        null,
      );
      return this.#decisionRow(entry, record);
    });
  }

  async resolveDecision(
    sessionId: SessionId | string,
    id: string,
    answer: string,
  ): Promise<AppStudioDecision> {
    const entry = await this.#requireEntry(sessionId);
    return this.#host.repository.runExclusive(entry.location, async () => {
      const repository = this.#repo<DecisionData>(
        entry,
        'decisions',
        'decision',
      );
      const current = await repository.get(id);
      if (!current) throw new Error('App decision not found');
      const next = await repository.update(id, {
        data: {
          ...current.data,
          status: 'resolved',
          answer,
          resolved_at: new Date().toISOString(),
        },
      });
      await this.#appendEventRecord(
        entry,
        'decision.resolved',
        'decision',
        id,
        JSON.stringify({ answer }),
        null,
      );
      return this.#decisionRow(entry, next);
    });
  }

  #eventRow(
    entry: AppEntry,
    record: EntityRecord<EventData>,
  ): AppStudioEvent {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
      created_at: record.createdAt,
    };
  }

  async appendEvent(
    sessionId: SessionId | string,
    kind: string,
    entityType: string,
    entityId: string,
    payloadJson = '{}',
    idempotencyKey?: string | null,
  ): Promise<AppStudioEvent> {
    const entry = await this.#requireEntry(sessionId);
    return this.#host.repository.runExclusive(entry.location, () =>
      this.#appendEventRecord(
        entry,
        kind,
        entityType,
        entityId,
        payloadJson,
        idempotencyKey ?? null,
      ),
    );
  }

  async listEvents(
    sessionId: SessionId | string,
    afterSeq = 0,
  ): Promise<AppStudioEvent[]> {
    const entry = await this.#requireEntry(sessionId);
    const records = (
      await this.#repo<EventData>(entry, 'events', 'event').list({
        limit: 1_000,
      })
    ).items
      .filter((record) => record.seq > afterSeq)
      .slice(0, 250);
    return records.map((record) => this.#eventRow(entry, record));
  }

  #deploymentRow(
    entry: AppEntry,
    record: EntityRecord<DeploymentData>,
  ): AppStudioDeployment {
    return {
      id: record.id,
      seq: record.seq,
      app_session_id: entry.session.id,
      ...record.data,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  async saveDeployment(input: {
    sessionId: SessionId | string;
    planRevisionId: string;
    status: AppStudioDeployment['status'];
    url?: string | null;
    account?: string | null;
    databaseId?: string | null;
    healthOk?: boolean;
    detailsJson?: string;
  }): Promise<AppStudioDeployment> {
    const entry = await this.#requireEntry(input.sessionId);
    const details = input.detailsJson ?? '{}';
    JSON.parse(details);
    return this.#host.repository.runExclusive(entry.location, async () => {
      const record = await this.#repo<DeploymentData>(
        entry,
        'deployments',
        'deployment',
      ).create({
        relations: { plan_revision: input.planRevisionId },
        data: {
          plan_revision_id: input.planRevisionId,
          status: input.status,
          url: input.url ?? null,
          account: input.account ?? null,
          database_id: input.databaseId ?? null,
          health_ok: input.healthOk ? 1 : 0,
          details_json: details,
        },
      });
      const deployment = this.#deploymentRow(entry, record);
      await this.#appendEventRecord(
        entry,
        `deployment.${input.status}`,
        'deployment',
        deployment.id,
        JSON.stringify({
          url: deployment.url,
          health_ok: !!deployment.health_ok,
        }),
        null,
      );
      return deployment;
    });
  }

  async getLatestDeployment(
    sessionId: SessionId | string,
  ): Promise<AppStudioDeployment | null> {
    const entry = await this.#requireEntry(sessionId);
    const record = (
      await this.#repo<DeploymentData>(
        entry,
        'deployments',
        'deployment',
      ).list({ limit: 1, order: 'desc' })
    ).items[0];
    return record ? this.#deploymentRow(entry, record) : null;
  }
}
