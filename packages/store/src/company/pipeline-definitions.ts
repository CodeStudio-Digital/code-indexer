import {
  CompanySessionRepository,
  asCompanySessionId,
  assertUuid,
  type CatalogEntry,
  type CompanyPipelineDefinitionData,
  type EntityRecord,
} from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type {
  Pipeline,
  PipelineGraph,
} from '@mcp/company/types.js';

export interface CreateSessionPipelineInput {
  name: string;
  description?: string;
  graph: PipelineGraph;
  companySessionId: string;
  templateId?: number | null;
}

export interface ListSessionPipelinesOptions {
  companySessionId?: string;
  templateId?: number | null;
}

export interface UpdateSessionPipelinePatch {
  name?: string;
  description?: string;
  graph?: PipelineGraph;
}

interface LocatedDefinition {
  entry: CatalogEntry;
  repository: CompanySessionRepository;
  record: EntityRecord<CompanyPipelineDefinitionData>;
}

interface RepositoryContext {
  repositories: Map<string, CompanySessionRepository>;
  owners: Map<string, string>;
}

const contexts = new WeakMap<FsSessionStore, RepositoryContext>();

function contextFor(store: FsSessionStore): RepositoryContext {
  let context = contexts.get(store);
  if (!context) {
    context = { repositories: new Map(), owners: new Map() };
    contexts.set(store, context);
  }
  return context;
}

function isCompanyEntry(entry: CatalogEntry): boolean {
  return entry.session.kind === 'company' ||
    entry.session.kind === 'app_studio';
}

function repositoryFor(
  store: FsSessionStore,
  entry: CatalogEntry,
): CompanySessionRepository {
  const context = contextFor(store);
  let repository = context.repositories.get(entry.location.bundle_path);
  if (!repository) {
    repository = new CompanySessionRepository({
      sessionRoot: entry.location.bundle_path,
    });
    context.repositories.set(entry.location.bundle_path, repository);
  }
  return repository;
}

function entryForSession(
  store: FsSessionStore,
  companySessionId: string,
): CatalogEntry {
  const normalized = asCompanySessionId(companySessionId);
  const entry = store.catalog.get(normalized);
  if (!entry || !isCompanyEntry(entry)) {
    throw new Error(
      `Unknown filesystem Company session ${normalized}; no SQLite pipeline fallback is available`,
    );
  }
  return entry;
}

function graphValue(value: unknown): PipelineGraph {
  if (
    value == null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { nodes?: unknown }).nodes) ||
    !Array.isArray((value as { edges?: unknown }).edges)
  ) {
    throw new Error('Corrupt filesystem pipeline definition graph');
  }
  return value as PipelineGraph;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function hydrate(
  companySessionId: string,
  record: EntityRecord<CompanyPipelineDefinitionData>,
): Pipeline {
  return {
    id: assertUuid(record.id, 'pipeline definition id'),
    name: record.data.name,
    description:
      typeof record.data.description === 'string'
        ? record.data.description
        : '',
    project_id: null,
    company_session_id: asCompanySessionId(companySessionId),
    template_id: nullableNumber(record.data.template_id),
    graph: graphValue(record.data.graph),
    version:
      typeof record.data.version === 'number' &&
      Number.isInteger(record.data.version) &&
      record.data.version > 0
        ? record.data.version
        : 1,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export async function locate(
  store: FsSessionStore,
  pipelineId: string,
): Promise<LocatedDefinition | null> {
  const normalized = assertUuid(pipelineId, 'pipeline definition id');
  const context = contextFor(store);
  const cachedOwner = context.owners.get(normalized);
  if (cachedOwner) {
    const entry = store.catalog.get(cachedOwner);
    if (entry && isCompanyEntry(entry)) {
      const repository = repositoryFor(store, entry);
      const record = await repository.get('pipelineDefinition', normalized);
      if (record) return { entry, repository, record };
    }
    context.owners.delete(normalized);
  }
  for (const entry of store.catalog.list()) {
    if (!isCompanyEntry(entry)) continue;
    const repository = repositoryFor(store, entry);
    const record = await repository.get('pipelineDefinition', normalized);
    if (!record) continue;
    context.owners.set(normalized, String(entry.session.id));
    return { entry, repository, record };
  }
  return null;
}

export async function create(
  store: FsSessionStore,
  input: CreateSessionPipelineInput,
): Promise<Pipeline> {
  const entry = entryForSession(store, input.companySessionId);
  const repository = repositoryFor(store, entry);
  const record = await store.runSessionMutation(
    entry.session.id,
    () =>
      repository.createPipelineDefinition({
        relations: {
          company_session_id: asCompanySessionId(input.companySessionId),
        },
        data: {
          name: input.name,
          description: input.description ?? '',
          graph: input.graph,
          version: 1,
          company_session_id: asCompanySessionId(input.companySessionId),
          project_id: null,
          template_id: input.templateId ?? null,
        },
      }),
  );
  contextFor(store).owners.set(record.id, String(entry.session.id));
  return hydrate(String(entry.session.id), record);
}

export async function get(
  store: FsSessionStore,
  pipelineId: string,
): Promise<Pipeline | null> {
  const located = await locate(store, pipelineId);
  return located
    ? hydrate(String(located.entry.session.id), located.record)
    : null;
}

async function listAll(
  repository: CompanySessionRepository,
): Promise<EntityRecord<CompanyPipelineDefinitionData>[]> {
  const records: EntityRecord<CompanyPipelineDefinitionData>[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list('pipelineDefinition', {
      cursor,
      limit: 1_000,
      order: 'desc',
    });
    records.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return records;
}

export async function list(
  store: FsSessionStore,
  options: ListSessionPipelinesOptions = {},
): Promise<Pipeline[]> {
  const entries = options.companySessionId
    ? [entryForSession(store, options.companySessionId)]
    : store.catalog.list().filter(isCompanyEntry);
  const pipelines: Pipeline[] = [];
  for (const entry of entries) {
    for (const record of await listAll(repositoryFor(store, entry))) {
      contextFor(store).owners.set(record.id, String(entry.session.id));
      const pipeline = hydrate(String(entry.session.id), record);
      if (
        options.templateId !== undefined &&
        pipeline.template_id !== options.templateId
      ) {
        continue;
      }
      pipelines.push(pipeline);
    }
  }
  return pipelines.sort(
    (left, right) =>
      Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
      String(right.id).localeCompare(String(left.id)),
  );
}

export async function update(
  store: FsSessionStore,
  pipelineId: string,
  patch: UpdateSessionPipelinePatch,
  options: { expectedVersion?: number } = {},
): Promise<Pipeline | null> {
  const located = await locate(store, pipelineId);
  if (!located) return null;
  const updated = await store.runSessionMutation(
    located.entry.session.id,
    async () => {
      const current = await located.repository.get(
        'pipelineDefinition',
        pipelineId,
      );
      if (!current) return null;
      const version =
        typeof current.data.version === 'number'
          ? current.data.version
          : 1;
      if (
        options.expectedVersion !== undefined &&
        version !== options.expectedVersion
      ) {
        const error = new Error(
          `Pipeline ${pipelineId} version mismatch: expected ${options.expectedVersion}, got ${version}`,
        );
        (error as { code?: string }).code = 'PIPELINE_VERSION_MISMATCH';
        throw error;
      }
      return located.repository.update(
        'pipelineDefinition',
        pipelineId,
        {
          data: {
            ...current.data,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined
              ? { description: patch.description }
              : {}),
            ...(patch.graph !== undefined ? { graph: patch.graph } : {}),
            version: version + 1,
          },
        },
      );
    },
  );
  return updated
    ? hydrate(String(located.entry.session.id), updated)
    : null;
}

export async function del(
  store: FsSessionStore,
  pipelineId: string,
): Promise<boolean> {
  const located = await locate(store, pipelineId);
  if (!located) return false;
  await store.runSessionMutation(
    located.entry.session.id,
    () =>
      located.repository.moveToTrash(
        'pipelineDefinition',
        assertUuid(pipelineId, 'pipeline definition id'),
      ),
  );
  contextFor(store).owners.delete(pipelineId);
  return true;
}
