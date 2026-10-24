import { appMetadata } from './app-studio-store-values.js';
import type { AppStudioSession, CreateAppStudioSessionInput, AppStudioEvent, AppStudioStoreHost, AppStudioMetadata, EventData, AppEntry } from './app-studio-store-types.js';
import { EntityFileRepository, assertExistingDirectory, type CompanySessionId, type EntityRecord, type JsonValue, type ProjectId, type SessionId, type SessionMetadata } from '@mcp/session-storage';

export class AppStudioSessionBase {
  readonly host: AppStudioStoreHost;
  readonly entityRepositories = new Map<string, EntityFileRepository<object>>();
  readyPromise: Promise<void> | null = null;

  constructor(host: AppStudioStoreHost) {
    this.host = host;
  }

  async ready(): Promise<void> {
    this.readyPromise ??= this.host.catalog.refresh().then(() => undefined);
    await this.readyPromise;
  }

  appEntries(): AppEntry[] {
    return this.host.catalog
      .list()
      .filter(
        (entry): entry is AppEntry =>
          entry.session.kind === 'app_studio' &&
          appMetadata(entry.session) != null,
      );
  }

  async entry(id: SessionId | string): Promise<AppEntry | null> {
    await this.ready();
    const entry = this.host.catalog.get(String(id));
    if (
      !entry ||
      entry.session.kind !== 'app_studio' ||
      appMetadata(entry.session) == null
    ) {
      return null;
    }
    await this.host.locator.assertSafeLocation(entry.location, {
      mustExist: true,
    });
    return entry as AppEntry;
  }

  async requireEntry(id: SessionId | string): Promise<AppEntry> {
    const entry = await this.entry(id);
    if (!entry) throw new Error(`App Studio session ${String(id)} not found`);
    return entry;
  }

  repo<T extends object>(
    entry: AppEntry,
    namespace: string,
    kind: string,
  ): EntityFileRepository<T> {
    const key = `${entry.location.bundle_path}\0${namespace}`;
    let repository = this.entityRepositories.get(key);
    if (!repository) {
      repository = new EntityFileRepository({
        sessionRoot: entry.location.bundle_path,
        namespace: `company/app-studio/${namespace}`,
        kind: `app_studio_${kind}`,
        journal: true,
      }) as EntityFileRepository<object>;
      this.entityRepositories.set(key, repository);
    }
    return repository as EntityFileRepository<T>;
  }

  session(entry: AppEntry): AppStudioSession {
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
    this.entityRepositories.clear();
  }

  async createSession(
    input: CreateAppStudioSessionInput,
  ): Promise<AppStudioSession> {
    await this.ready();
    if ((await this.getSessionByProjectId(input.project_id)) != null) {
      throw new Error(`Project ${input.project_id} already has an App Studio session`);
    }
    const project = this.host.getProject(input.project_id);
    if (!project) throw new Error(`Project ${input.project_id} is not registered`);
    const root = await assertExistingDirectory(
      project.root_path,
      `App Studio project root ${input.project_id}`,
    );
    const seq =
      this.appEntries().reduce(
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
    const entry = await this.host.repository.createSession({
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
    return this.session(entry as AppEntry);
  }

  async getSession(
    id: SessionId | string,
  ): Promise<AppStudioSession | null> {
    const entry = await this.entry(id);
    return entry ? this.session(entry) : null;
  }

  async getSessionByProjectId(
    projectId: ProjectId,
  ): Promise<AppStudioSession | null> {
    await this.ready();
    const entry = this.appEntries().find(
      (candidate) => appMetadata(candidate.session)!.project_id === projectId,
    );
    return entry ? this.session(entry) : null;
  }

  async getSessionByCompanySessionId(
    companySessionId: CompanySessionId | string,
  ): Promise<AppStudioSession | null> {
    await this.ready();
    const id = String(companySessionId);
    const entry = this.appEntries().find(
      (candidate) =>
        appMetadata(candidate.session)!.company_session_id === id,
    );
    return entry ? this.session(entry) : null;
  }

  async listSessions(): Promise<AppStudioSession[]> {
    await this.ready();
    return this.appEntries()
      .map((entry) => this.session(entry))
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
    const entry = await this.requireEntry(id);
    const company = this.host.catalog.get(String(companySessionId));
    if (
      !company ||
      !['company', 'app_studio'].includes(company.session.kind)
    ) {
      throw new Error(`Company session ${String(companySessionId)} not found`);
    }
    const session = await this.host.repository.updateSession(
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
    return this.session({ ...entry, session });
  }

  async deleteSession(id: SessionId | string): Promise<void> {
    const entry = await this.requireEntry(id);
    await this.host.repository.trashSession(entry.location);
  }

  async appendEventRecord(
    entry: AppEntry,
    kind: string,
    entityType: string,
    entityId: string,
    payloadJson: string,
    idempotencyKey: string | null,
  ): Promise<AppStudioEvent> {
    JSON.parse(payloadJson);
    const repository = this.repo<EventData>(entry, 'events', 'event');
    if (idempotencyKey) {
      const existing = (
        await repository.list({ limit: 1_000, order: 'desc' })
      ).items.find(
        (record) => record.data.idempotency_key === idempotencyKey,
      );
      if (existing) return this.eventRow(entry, existing);
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
    return this.eventRow(entry, record);
  }

  eventRow(
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
    const entry = await this.requireEntry(sessionId);
    return this.host.repository.runExclusive(entry.location, () =>
      this.appendEventRecord(
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
    const entry = await this.requireEntry(sessionId);
    const records = (
      await this.repo<EventData>(entry, 'events', 'event').list({
        limit: 1_000,
      })
    ).items
      .filter((record) => record.seq > afterSeq)
      .slice(0, 250);
    return records.map((record) => this.eventRow(entry, record));
  }
}
