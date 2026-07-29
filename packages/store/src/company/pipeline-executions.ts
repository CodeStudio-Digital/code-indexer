import {
  CompanySessionRepository,
  asSessionId,
  assertUuid,
  type CatalogEntry,
  type CompanyPipelineRunData,
  type EntityRecord,
} from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type {
  PipelineExecution,
  PipelineExecutionContext,
  PipelineId,
  PipelineExecutionStatus,
} from '@mcp/company/types.js';

export interface CreateExecutionInput {
  pipelineId: PipelineId;
  projectId?: number | null;
  companySessionId?: string | null;
  coderSessionId?: string | null;
  initialInput: string;
  context: PipelineExecutionContext;
  startedBy?: string;
  currentNodeId?: string | null;
}

export interface ListExecutionsOptions {
  companySessionId?: string;
  coderSessionId?: string;
  pipelineId?: PipelineId;
  status?: PipelineExecutionStatus;
  limit?: number;
}

export interface UpdateExecutionPatch {
  status?: PipelineExecutionStatus;
  currentNodeId?: string | null;
  context?: PipelineExecutionContext;
  finishedAt?: string | null;
  errorMessage?: string | null;
}

export interface LocatedPipelineExecution {
  entry: CatalogEntry;
  repository: CompanySessionRepository;
  record: EntityRecord<CompanyPipelineRunData>;
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

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function executionStatus(value: unknown): PipelineExecutionStatus {
  return value === 'paused' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'aborted'
    ? value
    : 'running';
}

function emptyContext(): PipelineExecutionContext {
  return {
    snapshot: { version: 1, nodes: [], edges: [] },
    vars: {},
  };
}

function pipelineIdValue(value: unknown): PipelineId {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return assertUuid(value, 'pipeline definition id');
  }
  throw new Error('Corrupt pipeline execution: invalid pipeline_id');
}

function hydrate(
  record: EntityRecord<CompanyPipelineRunData>,
): PipelineExecution {
  const data = record.data;
  const rawContext = data.context;
  const context =
    rawContext != null &&
    typeof rawContext === 'object' &&
    !Array.isArray(rawContext)
      ? rawContext as unknown as PipelineExecutionContext
      : emptyContext();
  return {
    id: assertUuid(record.id, 'pipeline execution id'),
    seq: record.seq,
    pipeline_id: pipelineIdValue(data.pipeline_id),
    project_id:
      typeof data.project_id === 'number' ? data.project_id : null,
    company_session_id: nullableString(data.company_session_id),
    coder_session_id: nullableString(data.coder_session_id),
    status: executionStatus(data.status),
    current_node_id: nullableString(data.current_node_id),
    initial_input:
      typeof data.initial_input === 'string' ? data.initial_input : '',
    context,
    started_by:
      typeof data.started_by === 'string' ? data.started_by : 'master',
    started_at:
      typeof data.started_at === 'string'
        ? data.started_at
        : record.createdAt,
    finished_at: nullableString(data.finished_at),
    error_message: nullableString(data.error_message),
  };
}

function entryForOwner(
  store: FsSessionStore,
  ownerSessionId: string,
): CatalogEntry {
  const normalized = asSessionId(ownerSessionId);
  const entry = store.catalog.get(normalized);
  if (!entry) {
    throw new Error(
      `Unknown filesystem session ${normalized}; no SQLite pipeline fallback is available`,
    );
  }
  return entry;
}

export async function locate(
  store: FsSessionStore,
  executionId: string,
): Promise<LocatedPipelineExecution | null> {
  const normalized = assertUuid(executionId, 'pipeline execution id');
  const context = contextFor(store);
  const cachedOwner = context.owners.get(normalized);
  if (cachedOwner) {
    const entry = store.catalog.get(cachedOwner);
    if (entry) {
      const repository = repositoryFor(store, entry);
      const record = await repository.get('pipelineRun', normalized);
      if (record) return { entry, repository, record };
    }
    context.owners.delete(normalized);
  }
  for (const entry of store.catalog.list()) {
    const repository = repositoryFor(store, entry);
    const record = await repository.get('pipelineRun', normalized);
    if (!record) continue;
    context.owners.set(normalized, String(entry.session.id));
    return { entry, repository, record };
  }
  return null;
}

export async function create(
  store: FsSessionStore,
  input: CreateExecutionInput,
): Promise<PipelineExecution> {
  const companyId = input.companySessionId ?? null;
  const coderId = input.coderSessionId ?? null;
  if ((companyId == null) === (coderId == null)) {
    throw new Error(
      'createPipelineExecution: exactly one of companySessionId / coderSessionId must be set',
    );
  }
  const ownerId = companyId ?? coderId!;
  const entry = entryForOwner(store, ownerId);
  const repository = repositoryFor(store, entry);
  const now = new Date().toISOString();
  const record = await store.runSessionMutation(
    entry.session.id,
    () =>
      repository.createPipelineRun({
        relations: {
          ...(companyId
            ? { company_session_id: asSessionId(companyId) }
            : { coder_session_id: asSessionId(coderId!) }),
          ...(typeof input.pipelineId === 'string'
            ? {
                pipeline_definition_id: assertUuid(
                  input.pipelineId,
                  'pipeline definition id',
                ),
              }
            : {}),
        },
        data: {
          status: 'running',
          pipeline_id: input.pipelineId,
          project_id: input.projectId ?? null,
          company_session_id: companyId,
          coder_session_id: coderId,
          current_node_id: input.currentNodeId ?? null,
          initial_input: input.initialInput,
          context: input.context,
          started_by: input.startedBy ?? 'master',
          started_at: now,
          finished_at: null,
          error_message: null,
        },
      }),
  );
  contextFor(store).owners.set(record.id, String(entry.session.id));
  return hydrate(record);
}

export async function get(
  store: FsSessionStore,
  id: string,
): Promise<PipelineExecution | null> {
  const located = await locate(store, id);
  return located ? hydrate(located.record) : null;
}

async function listAll(
  repository: CompanySessionRepository,
): Promise<EntityRecord<CompanyPipelineRunData>[]> {
  const records: EntityRecord<CompanyPipelineRunData>[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list('pipelineRun', {
      cursor,
      limit: 1_000,
      order: 'asc',
    });
    records.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return records;
}

export async function list(
  store: FsSessionStore,
  opts: ListExecutionsOptions,
): Promise<PipelineExecution[]> {
  const owner = opts.companySessionId ?? opts.coderSessionId ?? null;
  const entries = owner
    ? [entryForOwner(store, owner)]
    : [...store.catalog.list()];
  const rows: PipelineExecution[] = [];
  for (const entry of entries) {
    const records = await listAll(repositoryFor(store, entry));
    for (const record of records) {
      contextFor(store).owners.set(record.id, String(entry.session.id));
      rows.push(hydrate(record));
    }
  }
  return rows
    .filter(
      (row) =>
        opts.companySessionId == null ||
        row.company_session_id === opts.companySessionId,
    )
    .filter(
      (row) =>
        opts.coderSessionId == null ||
        row.coder_session_id === opts.coderSessionId,
    )
    .filter(
      (row) =>
        opts.pipelineId == null ||
        row.pipeline_id === opts.pipelineId,
    )
    .filter(
      (row) => opts.status == null || row.status === opts.status,
    )
    .sort(
      (left, right) =>
        Date.parse(right.started_at) - Date.parse(left.started_at) ||
        right.seq - left.seq,
    )
    .slice(0, Math.max(1, Math.floor(opts.limit ?? 100)));
}

export async function update(
  store: FsSessionStore,
  id: string,
  patch: UpdateExecutionPatch,
): Promise<PipelineExecution | null> {
  const located = await locate(store, id);
  if (!located) return null;
  const updated = await store.runSessionMutation(
    located.entry.session.id,
    async () => {
      const latest = await located.repository.get('pipelineRun', id);
      if (!latest) return null;
      return located.repository.update('pipelineRun', id, {
        data: {
          ...latest.data,
          ...(patch.status !== undefined
            ? { status: patch.status }
            : {}),
          ...(patch.currentNodeId !== undefined
            ? { current_node_id: patch.currentNodeId }
            : {}),
          ...(patch.context !== undefined
            ? { context: patch.context }
            : {}),
          ...(patch.finishedAt !== undefined
            ? { finished_at: patch.finishedAt }
            : {}),
          ...(patch.errorMessage !== undefined
            ? { error_message: patch.errorMessage }
            : {}),
        },
      });
    },
  );
  return updated ? hydrate(updated) : null;
}
