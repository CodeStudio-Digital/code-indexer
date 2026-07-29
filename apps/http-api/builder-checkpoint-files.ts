import {
  ArtifactStore,
  EntityFileRepository,
  asSessionId,
  isUuid,
  type ArtifactRef,
  type CatalogEntry,
  type EntityRecord,
  type SessionCatalog,
  type SessionId,
} from '@mcp/session-storage';

const CHECKPOINT_NAMESPACE = 'checkpoints/builder';
const CHECKPOINT_KIND = 'builder_checkpoint';

export type BuilderCheckpointKind =
  | 'auto'
  | 'visual'
  | 'restore'
  | 'manual';

export interface BuilderCheckpointData {
  [key: string]: unknown;
  schema_version: 1;
  session_id: string;
  project_id: number;
  commit_sha: string;
  label: string;
  kind: BuilderCheckpointKind;
  screenshot: ArtifactRef | null;
}

export interface BuilderCheckpoint {
  id: string;
  seq: number;
  session_id: string;
  project_id: number;
  commit_sha: string;
  label: string;
  kind: BuilderCheckpointKind;
  screenshot: ArtifactRef | null;
  created_at: string;
  updated_at: string;
}

export interface BuilderCheckpointSessionStore {
  readonly catalog: Pick<SessionCatalog, 'get' | 'list'>;
  ensureCatalog(): Promise<void>;
  runSessionMutation<T>(
    id: SessionId | string,
    task: () => Promise<T>,
  ): Promise<T>;
}

export interface LocatedBuilderCheckpoint {
  entry: CatalogEntry;
  record: EntityRecord<BuilderCheckpointData>;
  checkpoint: BuilderCheckpoint;
}

function repositoryFor(
  entry: CatalogEntry,
): EntityFileRepository<BuilderCheckpointData> {
  return new EntityFileRepository<BuilderCheckpointData>({
    sessionRoot: entry.location.bundle_path,
    namespace: CHECKPOINT_NAMESPACE,
    kind: CHECKPOINT_KIND,
  });
}

function belongsToProject(entry: CatalogEntry, projectId: number): boolean {
  return (
    entry.session.owner_project_id === projectId ||
    (entry.session.storage_scope.kind === 'project' &&
      entry.session.storage_scope.project_id === projectId) ||
    entry.session.linked_projects.some(
      (project) => project.project_id === projectId,
    )
  );
}

function projectEntries(
  catalog: Pick<SessionCatalog, 'list'>,
  projectId: number,
): CatalogEntry[] {
  return catalog
    .list()
    .filter((entry) => belongsToProject(entry, projectId));
}

function toCheckpoint(
  record: EntityRecord<BuilderCheckpointData>,
): BuilderCheckpoint {
  return {
    id: record.id,
    seq: record.seq,
    session_id: record.data.session_id,
    project_id: record.data.project_id,
    commit_sha: record.data.commit_sha,
    label: record.data.label,
    kind: record.data.kind,
    screenshot: record.data.screenshot,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

async function allRecords(
  repository: EntityFileRepository<BuilderCheckpointData>,
): Promise<EntityRecord<BuilderCheckpointData>[]> {
  const records: EntityRecord<BuilderCheckpointData>[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list({
      order: 'desc',
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    records.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return records;
}

function assertRecordOwnership(
  entry: CatalogEntry,
  record: EntityRecord<BuilderCheckpointData>,
): void {
  if (record.data.session_id !== entry.session.id) {
    throw new Error(
      `Builder checkpoint ${record.id} session owner does not match its bundle`,
    );
  }
}

export async function listBuilderCheckpointFiles(
  sessions: BuilderCheckpointSessionStore,
  projectId: number,
): Promise<BuilderCheckpoint[]> {
  await sessions.ensureCatalog();
  const located = (
    await Promise.all(
      projectEntries(sessions.catalog, projectId).map(async (entry) => {
        const records = await allRecords(repositoryFor(entry));
        return records.map((record) => ({ entry, record }));
      }),
    )
  ).flat();

  return located
    .filter(({ entry, record }) => {
      assertRecordOwnership(entry, record);
      return record.data.project_id === projectId;
    })
    .map(({ record }) => toCheckpoint(record))
    .sort(
      (left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at) ||
        right.id.localeCompare(left.id),
    );
}

export async function findBuilderCheckpointFile(
  sessions: BuilderCheckpointSessionStore,
  projectId: number,
  checkpointId: string,
): Promise<LocatedBuilderCheckpoint | null> {
  if (!isUuid(checkpointId)) return null;
  const normalized = checkpointId.toLowerCase();
  await sessions.ensureCatalog();
  const matches = (
    await Promise.all(
      projectEntries(sessions.catalog, projectId).map(async (entry) => {
        const record = await repositoryFor(entry).get(normalized);
        if (!record || record.data.project_id !== projectId) return null;
        assertRecordOwnership(entry, record);
        return {
          entry,
          record,
          checkpoint: toCheckpoint(record),
        };
      }),
    )
  ).filter(
    (value): value is LocatedBuilderCheckpoint => value !== null,
  );
  if (matches.length > 1) {
    throw new Error(
      `Duplicate builder checkpoint UUID ${normalized} found in session bundles`,
    );
  }
  return matches[0] ?? null;
}

export async function resolveBuilderCheckpointOwner(
  sessions: BuilderCheckpointSessionStore,
  projectId: number,
  requestedSessionId?: string,
): Promise<CatalogEntry | null> {
  await sessions.ensureCatalog();
  if (requestedSessionId != null) {
    if (!isUuid(requestedSessionId)) return null;
    const entry = sessions.catalog.get(asSessionId(requestedSessionId));
    return entry && belongsToProject(entry, projectId) ? entry : null;
  }

  return (
    projectEntries(sessions.catalog, projectId).find(
      (entry) =>
        entry.session.kind === 'coder' &&
        entry.session.archived_at == null &&
        entry.state?.archived_at == null,
    ) ?? null
  );
}

export async function createBuilderCheckpointFile(
  sessions: BuilderCheckpointSessionStore,
  entry: CatalogEntry,
  input: {
    project_id: number;
    commit_sha: string;
    label: string;
    kind: BuilderCheckpointKind;
    screenshot?: ArtifactRef | null;
  },
): Promise<LocatedBuilderCheckpoint> {
  const data: BuilderCheckpointData = {
    schema_version: 1,
    session_id: entry.session.id,
    project_id: input.project_id,
    commit_sha: input.commit_sha,
    label: input.label,
    kind: input.kind,
    screenshot: input.screenshot ?? null,
  };
  const record = await sessions.runSessionMutation(
    entry.session.id,
    () => repositoryFor(entry).create({ data }),
  );
  return { entry, record, checkpoint: toCheckpoint(record) };
}

export async function setBuilderCheckpointScreenshot(
  sessions: BuilderCheckpointSessionStore,
  entry: CatalogEntry,
  checkpointId: string,
  screenshot: ArtifactRef,
): Promise<BuilderCheckpoint> {
  const record = await sessions.runSessionMutation(
    entry.session.id,
    async () => {
      const repository = repositoryFor(entry);
      const current = await repository.require(checkpointId);
      assertRecordOwnership(entry, current);
      return repository.update(checkpointId, {
        data: { ...current.data, screenshot },
      });
    },
  );
  return toCheckpoint(record);
}

export function readBuilderCheckpointThumbnail(
  located: LocatedBuilderCheckpoint,
): { bytes: Uint8Array; mediaType: string } | null {
  const screenshot = located.record.data.screenshot;
  if (!screenshot) return null;
  if (
    screenshot.kind !== 'snapshot_blob' ||
    (screenshot.media_type != null &&
      !screenshot.media_type.startsWith('image/'))
  ) {
    throw new Error('Builder checkpoint thumbnail is not an image artifact');
  }
  const bytes = new ArtifactStore({
    bundlePath: located.entry.location.bundle_path,
    sessionId: located.entry.location.session_id,
  }).read(screenshot);
  return {
    bytes,
    mediaType: screenshot.media_type ?? 'image/jpeg',
  };
}
