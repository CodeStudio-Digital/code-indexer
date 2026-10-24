import {
  CompanySessionRepository,
  ControlPlaneFileRepository,
  asSessionId,
  assertExistingDirectory,
  type CatalogEntry,
  type CompanySessionId,
  type EntityRecord,
  type FileSessionRepository,
  type JsonValue,
  type ProjectId,
  type SessionCatalog,
  type SessionId,
  type SessionLocator,
  type SessionMetadata,
  type SessionState,
} from '@mcp/session-storage';

export type OperationalRuntimeKind = 'company' | 'app_studio';

interface OperationalProject {
  id: ProjectId;
  name: string;
  root_path: string;
}

interface OperationalProjectResolver {
  getProject(projectId: ProjectId): OperationalProject | null;
}

export interface CompanySessionFileRow {
  id: CompanySessionId;
  template_id: number | null;
  runtime_kind: OperationalRuntimeKind;
  name: string;
  status: string;
  master_session_id: SessionId | null;
  config_json: string;
  parent_session_id: CompanySessionId | null;
  archived_at: string | null;
  recovered_at: string | null;
  recovered_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface CompanySessionProjectFileRow {
  company_session_id: CompanySessionId;
  project_id: ProjectId;
  label: string | null;
}

interface CompanySessionFullFileRow {
  session: CompanySessionFileRow;
  projects: CompanySessionProjectFileRow[];
  agentRuns: Array<Record<string, unknown>>;
  recentBoard: Array<Record<string, unknown>>;
  masterPrompts: Array<Record<string, unknown>>;
}

export interface CreateCompanyFileSessionInput {
  name: string;
  project_ids: readonly ProjectId[];
  project_labels?: Readonly<Record<number, string | undefined>>;
  template_id?: number | null;
  config_json?: string;
  runtime_kind?: OperationalRuntimeKind;
  parent_session_id?: CompanySessionId | null;
}

type CompanyMetadata = {
  name: string;
  template_id: number | null;
  runtime_kind: OperationalRuntimeKind;
  config_json: string;
  master_session_id: string | null;
  project_labels: Record<string, string | null>;
  recovered_at: string | null;
  recovered_reason: string | null;
};

function jsonObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asCompanyMetadata(session: SessionMetadata): CompanyMetadata {
  const raw = jsonObject(session.metadata.company);
  return {
    name: typeof raw.name === 'string' ? raw.name : session.title ?? 'Company',
    template_id:
      typeof raw.template_id === 'number' ? raw.template_id : null,
    runtime_kind:
      raw.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
    config_json:
      typeof raw.config_json === 'string' ? raw.config_json : '{}',
    master_session_id:
      typeof raw.master_session_id === 'string' ? raw.master_session_id : null,
    project_labels: Object.fromEntries(
      Object.entries(jsonObject(raw.project_labels)).map(([key, label]) => [
        key,
        typeof label === 'string' ? label : null,
      ]),
    ),
    recovered_at:
      typeof raw.recovered_at === 'string' ? raw.recovered_at : null,
    recovered_reason:
      typeof raw.recovered_reason === 'string' ? raw.recovered_reason : null,
  };
}

function entityData(
  record: EntityRecord<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id: record.id,
    seq: record.seq,
    ...record.data,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

/**
 * Host-owned filesystem authority for Company, App Studio and control-plane
 * records. It deliberately receives only project-catalog
 * reads: session state can never fall back to, or dual-write into, SQLite.
 */
export class OperationalSessionFiles {
  readonly #repository: FileSessionRepository;
  readonly #catalog: SessionCatalog;
  readonly #locator: SessionLocator;
  readonly #projects: OperationalProjectResolver;
  #catalogReady: Promise<void> | null = null;

  constructor(input: {
    repository: FileSessionRepository;
    catalog: SessionCatalog;
    locator: SessionLocator;
    projects: OperationalProjectResolver;
  }) {
    this.#repository = input.repository;
    this.#catalog = input.catalog;
    this.#locator = input.locator;
    this.#projects = input.projects;
  }

  async #ready(): Promise<void> {
    if (!this.#catalogReady) {
      this.#catalogReady = this.#catalog.ensureReady();
    }
    await this.#catalogReady;
  }

  async #entry(id: string): Promise<CatalogEntry | null> {
    await this.#ready();
    let entry = this.#catalog.get(id);
    if (!entry) {
      // Another process (for example the Company worker) may have created the
      // bundle after this host catalog was first scanned.
      await this.#catalog.refresh();
      entry = this.#catalog.get(id);
    }
    return entry ? this.#freshEntry(entry) : null;
  }

  #freshEntry(entry: CatalogEntry): CatalogEntry | null {
    try {
      // Repository events keep the catalog current only for writes made in
      // this process. Company workers mutate the same bundle from a different
      // process, so read the two small authoritative projections before
      // returning lifecycle/configuration state through the HTTP API.
      return {
        ...entry,
        session: this.#repository.readSessionSync(entry.location),
        state: this.#repository.readStateSync(entry.location),
      };
    } catch {
      // A concurrently removed bundle must disappear from API reads rather
      // than leak the last cached projection.
      return null;
    }
  }

  async #requireEntry(
    id: string,
    allowedKinds?: readonly string[],
  ): Promise<CatalogEntry> {
    const entry = await this.#entry(id);
    if (!entry) throw new Error(`Unknown filesystem session ${id}`);
    if (allowedKinds && !allowedKinds.includes(entry.session.kind)) {
      throw new Error(
        `Session ${id} has kind ${entry.session.kind}; expected ${allowedKinds.join(' or ')}`,
      );
    }
    await this.#locator.assertSafeLocation(entry.location, { mustExist: true });
    return entry;
  }

  async #project(projectId: ProjectId): Promise<OperationalProject> {
    const project = this.#projects.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} is not registered`);
    }
    await assertExistingDirectory(project.root_path, `project root ${projectId}`);
    return project;
  }

  #companyRow(entry: CatalogEntry): CompanySessionFileRow {
    const company = asCompanyMetadata(entry.session);
    return {
      id: entry.session.id as unknown as CompanySessionId,
      template_id: company.template_id,
      runtime_kind: company.runtime_kind,
      name: company.name,
      status: entry.state?.status ?? 'idle',
      master_session_id:
        company.master_session_id == null
          ? null
          : asSessionId(company.master_session_id),
      config_json: company.config_json,
      parent_session_id:
        entry.session.parent_session_id as unknown as CompanySessionId | null,
      archived_at: entry.state?.archived_at ?? null,
      recovered_at: company.recovered_at,
      recovered_reason: company.recovered_reason,
      created_at: entry.session.created_at,
      updated_at: entry.session.updated_at,
    };
  }

  #companyProjects(entry: CatalogEntry): CompanySessionProjectFileRow[] {
    const labels = asCompanyMetadata(entry.session).project_labels;
    return entry.session.linked_projects.map((project) => ({
      company_session_id: entry.session.id as unknown as CompanySessionId,
      project_id: project.project_id,
      label: labels[String(project.project_id)] ?? null,
    }));
  }

  async createCompanySession(
    input: CreateCompanyFileSessionInput,
  ): Promise<CompanySessionFileRow> {
    await this.#ready();
    const name = input.name.trim();
    if (!name) throw new TypeError('Company session name is required');
    const projectIds = [...new Set(input.project_ids)];
    if (projectIds.length === 0) {
      throw new TypeError('Company session requires at least one project');
    }
    const projects = await Promise.all(projectIds.map((id) => this.#project(id)));
    const runtimeKind = input.runtime_kind ?? 'company';
    const global = runtimeKind === 'app_studio' || projects.length > 1;
    if (input.parent_session_id) {
      await this.#requireEntry(input.parent_session_id, ['company']);
    }
    const labels = Object.fromEntries(
      projects.map((project) => [
        String(project.id),
        input.project_labels?.[project.id] ?? null,
      ]),
    );
    const company: CompanyMetadata = {
      name,
      template_id: input.template_id ?? null,
      runtime_kind: runtimeKind,
      config_json: input.config_json ?? '{}',
      master_session_id: null,
      project_labels: labels,
      recovered_at: null,
      recovered_reason: null,
    };
    const entry = await this.#repository.createSession({
      kind: runtimeKind,
      scope: global
        ? { kind: 'global' }
        : { kind: 'project', project_id: projects[0].id },
      owner_project_id: projects[0].id,
      linked_projects: projects.map((project) => ({
        project_id: project.id,
        root_path: project.root_path,
      })),
      parent_session_id: input.parent_session_id
        ? asSessionId(input.parent_session_id)
        : null,
      title: name,
      status: 'idle',
      metadata: { company } as unknown as Record<string, JsonValue>,
    });
    return this.#companyRow(entry);
  }

  async getCompanySession(
    id: CompanySessionId | string,
  ): Promise<CompanySessionFileRow | null> {
    const entry = await this.#entry(String(id));
    if (!entry || (entry.session.kind !== 'company' && entry.session.kind !== 'app_studio')) {
      return null;
    }
    return this.#companyRow(entry);
  }

  async listCompanySessions(input: {
    status?: string;
    includeChildren?: boolean;
  } = {}): Promise<CompanySessionFileRow[]> {
    await this.#ready();
    return this.#catalog
      .list()
      // Kind and parent are immutable session metadata already held by the
      // shared catalog. Narrow first: #freshEntry performs two synchronous,
      // path-safe reads and must never run for every historical Coder bundle.
      .filter((entry) =>
        (entry.session.kind === 'company' || entry.session.kind === 'app_studio') &&
        (input.includeChildren || entry.session.parent_session_id == null),
      )
      .map((entry) => this.#freshEntry(entry))
      .filter((entry): entry is CatalogEntry => entry != null)
      .filter((entry) =>
        (!input.status || entry.state?.status === input.status),
      )
      .map((entry) => this.#companyRow(entry));
  }

  async getCompanySessionFull(
    id: CompanySessionId | string,
  ): Promise<CompanySessionFullFileRow | null> {
    const entry = await this.#entry(String(id));
    if (!entry || (entry.session.kind !== 'company' && entry.session.kind !== 'app_studio')) {
      return null;
    }
    const repository = new CompanySessionRepository({
      sessionRoot: entry.location.bundle_path,
    });
    const [agentRuns, board, prompts] = await Promise.all([
      repository.list('agentRun', { limit: 500 }),
      repository.list('boardItem', { limit: 50 }),
      repository.list('masterPrompt', { limit: 50 }),
    ]);
    return {
      session: this.#companyRow(entry),
      projects: this.#companyProjects(entry),
      agentRuns: agentRuns.items.map((item) =>
        entityData(item as EntityRecord<Record<string, unknown>>)),
      recentBoard: board.items.map((item) =>
        entityData(item as EntityRecord<Record<string, unknown>>)),
      masterPrompts: prompts.items.map((item) =>
        entityData(item as EntityRecord<Record<string, unknown>>)),
    };
  }

  async renameCompanySession(
    id: CompanySessionId | string,
    name: string,
  ): Promise<CompanySessionFileRow> {
    const entry = await this.#requireEntry(String(id), ['company', 'app_studio']);
    const trimmed = name.trim();
    if (!trimmed) throw new TypeError('Company session name is required');
    const session = await this.#repository.updateSession(
      entry.location,
      (current) => {
        const company = asCompanyMetadata(current);
        return {
          ...current,
          title: trimmed,
          metadata: {
            ...current.metadata,
            company: { ...company, name: trimmed },
          },
        } as SessionMetadata;
      },
    );
    return this.#companyRow({
      ...entry,
      session,
      state: this.#repository.readStateSync(entry.location),
    });
  }

  async updateCompanySessionConfig(
    id: CompanySessionId | string,
    configJson: string,
  ): Promise<CompanySessionFileRow> {
    JSON.parse(configJson);
    const entry = await this.#requireEntry(String(id), ['company', 'app_studio']);
    const session = await this.#repository.updateSession(
      entry.location,
      (current) => ({
        ...current,
        metadata: {
          ...current.metadata,
          company: {
            ...asCompanyMetadata(current),
            config_json: configJson,
          },
        },
      }) as SessionMetadata,
    );
    return this.#companyRow({
      ...entry,
      session,
      state: this.#repository.readStateSync(entry.location),
    });
  }

  async updateCompanySessionStatus(
    id: CompanySessionId | string,
    status: string,
  ): Promise<CompanySessionFileRow> {
    const entry = await this.#requireEntry(String(id), ['company', 'app_studio']);
    const state = await this.#repository.updateState(
      entry.location,
      (current) => ({ ...current, status }) as SessionState,
    );
    return this.#companyRow({ ...entry, state });
  }

  async deleteCompanySession(
    id: CompanySessionId | string,
  ): Promise<boolean> {
    const entry = await this.#entry(String(id));
    if (!entry || (entry.session.kind !== 'company' && entry.session.kind !== 'app_studio')) {
      return false;
    }
    await this.#repository.trashSession(entry.location);
    return true;
  }

  async company(
    id: CompanySessionId | string,
  ): Promise<CompanySessionRepository> {
    const entry = await this.#requireEntry(String(id), ['company', 'app_studio']);
    return new CompanySessionRepository({
      sessionRoot: entry.location.bundle_path,
    });
  }

  async controlPlane(
    id: SessionId | string,
  ): Promise<ControlPlaneFileRepository> {
    const entry = await this.#requireEntry(String(id));
    return new ControlPlaneFileRepository({
      sessionRoot: entry.location.bundle_path,
    });
  }

}
