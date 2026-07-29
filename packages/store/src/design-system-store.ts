/**
 * Filesystem Design System store.
 *
 * A Design System is a `kind=design` session bundle. Listing metadata lives
 * in session.json, mutable pipeline state in state.json, and every version
 * and component has its own JSON file below design/. There is no SQLite
 * constructor, compatibility read or dual-write path.
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  asCompanySessionId,
  asSessionId,
  assertUuid,
  isUuid,
  type ArtifactRef,
  type CatalogEntry,
  type CompanySessionId,
  type FileSessionRepository,
  type JsonValue,
  type ProjectId,
  type SessionCatalog,
  type SessionId,
  type SessionProjectLink,
  type SessionStorageScope,
} from '@mcp/session-storage';
import {
  DesignSystemSessionRepository,
  type DesignComponentData,
  type DesignVersionData,
} from '@mcp/session-storage/entities/design-system-session-repository.js';
import type { EntityRecord } from '@mcp/session-storage/entities/entity-file-repository.js';

export type DsStack = 'react-ts' | 'vue-ts' | 'angular';
export type DsBumpHint = 'patch' | 'minor' | 'major';
export type DsBumpKind = 'initial' | 'patch' | 'minor' | 'major';
export type DsVersionStatus =
  | 'draft'
  | 'building'
  | 'published'
  | 'failed'
  | 'skipped';
export type DsComponentKind = 'atom' | 'page-template';
export type DsSessionKind = 'company' | 'studio';
export type DsSessionMode = 'fidelity' | 'creative';
export type DesignSystemSessionId = SessionId;
export type DesignSystemVersionId = string & {
  readonly __brand: 'DesignSystemVersionId';
};
export type DesignSystemComponentId = string & {
  readonly __brand: 'DesignSystemComponentId';
};

export interface DesignSystemSession {
  id: DesignSystemSessionId;
  company_session_id: CompanySessionId | null;
  project_id: ProjectId | null;
  kind: DsSessionKind;
  name: string;
  package_name: string;
  stack: DsStack;
  source_zip_hash: string | null;
  /** Absolute hydrated path to the bundle-owned attachment. */
  source_zip_path: string | null;
  next_bump_hint: DsBumpHint;
  mcp_server_config_id: string | null;
  mode: DsSessionMode;
  pipeline_json: string | null;
  created_at: string;
}

export interface DesignSystemVersion {
  id: DesignSystemVersionId;
  ds_session_id: DesignSystemSessionId;
  semver: string;
  bump_kind: DsBumpKind;
  is_auto_bump: boolean;
  status: DsVersionStatus;
  source_hash: string | null;
  tarball_path: string | null;
  manifest_json: string | null;
  mcp_manifest_json: string | null;
  docs_md: string | null;
  storybook_path: string | null;
  error: string | null;
  created_at: string;
  published_at: string | null;
}

export interface DesignSystemComponent {
  id: DesignSystemComponentId;
  version_id: DesignSystemVersionId;
  name: string;
  kind: DsComponentKind;
  props_schema_json: string | null;
  example_code: string | null;
  created_at: string;
}

export interface CreateDsSessionInput {
  company_session_id: CompanySessionId;
  name: string;
  package_name: string;
  stack: DsStack;
  source_zip_hash?: string | null;
  source_zip_path?: string | null;
}

export interface CreateDsStudioSessionInput {
  project_id: ProjectId;
  name: string;
  package_name: string;
  stack: DsStack;
  mode?: DsSessionMode;
  source_zip_hash?: string | null;
  source_zip_path?: string | null;
}

export interface CreateDsVersionInput {
  ds_session_id: DesignSystemSessionId;
  semver: string;
  bump_kind: DsBumpKind;
  is_auto_bump?: boolean;
  status?: DsVersionStatus;
  source_hash?: string | null;
}

export interface UpdateDsVersionArtifacts {
  semver?: string;
  bump_kind?: DsBumpKind;
  is_auto_bump?: boolean;
  status?: DsVersionStatus;
  source_hash?: string | null;
  tarball_path?: string | null;
  manifest_json?: string | null;
  mcp_manifest_json?: string | null;
  docs_md?: string | null;
  storybook_path?: string | null;
  error?: string | null;
  markPublished?: boolean;
}

export interface CreateDsComponentInput {
  version_id: DesignSystemVersionId;
  name: string;
  kind: DsComponentKind;
  props_schema_json?: string | null;
  example_code?: string | null;
}

export interface DesignSystemSessionFiles {
  readonly repository: FileSessionRepository;
  readonly catalog: SessionCatalog;
  ensureCatalog(): Promise<void>;
}

interface DesignMetadata {
  kind: DsSessionKind;
  name: string;
  packageName: string;
  stack: DsStack;
  sourceZipHash: string | null;
  sourceZipRef: ArtifactRef | null;
  nextBumpHint: DsBumpHint;
  mcpServerConfigId: string | null;
  mode: DsSessionMode;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function metadataFromEntry(entry: CatalogEntry): DesignMetadata {
  const raw = objectValue(entry.session.metadata.design);
  const kind: DsSessionKind = raw.kind === 'company' ? 'company' : 'studio';
  const stack: DsStack =
    raw.stack === 'vue-ts' || raw.stack === 'angular'
      ? raw.stack
      : 'react-ts';
  const nextBumpHint: DsBumpHint =
    raw.nextBumpHint === 'minor' || raw.nextBumpHint === 'major'
      ? raw.nextBumpHint
      : 'patch';
  const mode: DsSessionMode =
    raw.mode === 'fidelity' ? 'fidelity' : 'creative';
  const sourceZipRefRaw = objectValue(raw.sourceZipRef);
  const sourceZipRef =
    typeof sourceZipRefRaw.relative_path === 'string' &&
    typeof sourceZipRefRaw.sha256 === 'string'
      ? sourceZipRefRaw as unknown as ArtifactRef
      : null;
  return {
    kind,
    name:
      typeof raw.name === 'string'
        ? raw.name
        : entry.session.title ?? '',
    packageName:
      typeof raw.packageName === 'string' ? raw.packageName : '',
    stack,
    sourceZipHash: nullableString(raw.sourceZipHash),
    sourceZipRef,
    nextBumpHint,
    mcpServerConfigId: nullableString(raw.mcpServerConfigId),
    mode,
  };
}

function metadataJson(metadata: DesignMetadata): JsonValue {
  return {
    kind: metadata.kind,
    name: metadata.name,
    packageName: metadata.packageName,
    stack: metadata.stack,
    sourceZipHash: metadata.sourceZipHash,
    sourceZipRef: metadata.sourceZipRef as unknown as JsonValue,
    nextBumpHint: metadata.nextBumpHint,
    mcpServerConfigId: metadata.mcpServerConfigId,
    mode: metadata.mode,
  };
}

function pipelineJson(entry: CatalogEntry): string | null {
  const design = objectValue(entry.state?.extra.design);
  return nullableString(design.pipelineJson);
}

function sessionFromEntry(entry: CatalogEntry): DesignSystemSession {
  const metadata = metadataFromEntry(entry);
  const sourcePath = metadata.sourceZipRef
    ? join(
        entry.location.bundle_path,
        ...metadata.sourceZipRef.relative_path.split('/'),
      )
    : null;
  return {
    id: entry.session.id,
    company_session_id:
      metadata.kind === 'company' && entry.session.parent_session_id
        ? asCompanySessionId(String(entry.session.parent_session_id))
        : null,
    project_id:
      metadata.kind === 'studio' ? entry.session.owner_project_id : null,
    kind: metadata.kind,
    name: metadata.name,
    package_name: metadata.packageName,
    stack: metadata.stack,
    source_zip_hash: metadata.sourceZipHash,
    source_zip_path: sourcePath,
    next_bump_hint: metadata.nextBumpHint,
    mcp_server_config_id: metadata.mcpServerConfigId,
    mode: metadata.mode,
    pipeline_json: pipelineJson(entry),
    created_at: entry.session.created_at,
  };
}

function versionFromRecord(
  entry: CatalogEntry,
  record: {
    id: string;
    createdAt: string;
    data: DesignVersionData;
  },
): DesignSystemVersion {
  const tarballPath = record.data.tarballRef
    ? join(
        entry.location.bundle_path,
        ...record.data.tarballRef.relative_path.split('/'),
      )
    : null;
  return {
    id: record.id as DesignSystemVersionId,
    ds_session_id: entry.session.id,
    semver: record.data.semver,
    bump_kind: record.data.bumpKind as DsBumpKind,
    is_auto_bump: record.data.isAutoBump,
    status: record.data.status as DsVersionStatus,
    source_hash: record.data.sourceHash,
    tarball_path: tarballPath,
    manifest_json: record.data.manifestJson,
    mcp_manifest_json: record.data.mcpManifestJson,
    docs_md: record.data.docsMarkdown,
    storybook_path: record.data.storybookPath,
    error: record.data.error,
    created_at: record.createdAt,
    published_at: record.data.publishedAt,
  };
}

function componentFromRecord(record: {
  id: string;
  createdAt: string;
  data: DesignComponentData;
}): DesignSystemComponent {
  return {
    id: record.id as DesignSystemComponentId,
    version_id: record.data.versionId as DesignSystemVersionId,
    name: record.data.name,
    kind: record.data.componentKind as DsComponentKind,
    props_schema_json: record.data.propsSchemaJson,
    example_code: record.data.exampleCode,
    created_at: record.createdAt,
  };
}

export class DesignSystemStore {
  private readonly repositories = new Map<
    string,
    DesignSystemSessionRepository
  >();
  private readonly versionOwners = new Map<string, DesignSystemSessionId>();
  private readonly componentOwners = new Map<string, DesignSystemSessionId>();

  constructor(private readonly sessions: DesignSystemSessionFiles) {}

  close(): void {
    this.repositories.clear();
    this.versionOwners.clear();
    this.componentOwners.clear();
  }

  private repository(entry: CatalogEntry): DesignSystemSessionRepository {
    const key = String(entry.session.id);
    let repository = this.repositories.get(key);
    if (!repository) {
      repository = new DesignSystemSessionRepository({
        sessionRoot: entry.location.bundle_path,
      });
      this.repositories.set(key, repository);
    }
    return repository;
  }

  private async designEntries(): Promise<CatalogEntry[]> {
    await this.sessions.ensureCatalog();
    return this.sessions.catalog
      .list()
      .filter((entry) => entry.session.kind === 'design');
  }

  private async entry(
    id: DesignSystemSessionId | string,
  ): Promise<CatalogEntry | null> {
    if (!isUuid(id)) return null;
    await this.sessions.ensureCatalog();
    const entry = this.sessions.catalog.get(asSessionId(String(id)));
    return entry?.session.kind === 'design' ? entry : null;
  }

  private async requireEntry(
    id: DesignSystemSessionId | string,
  ): Promise<CatalogEntry> {
    const entry = await this.entry(id);
    if (!entry) throw new Error(`Design System session ${String(id)} not found`);
    await this.sessions.repository.primeSession(entry.location);
    return entry;
  }

  private async createBundle(input: {
    scope: SessionStorageScope;
    ownerProjectId: ProjectId | null;
    linkedProjects: readonly SessionProjectLink[];
    parentSessionId: SessionId | null;
    metadata: DesignMetadata;
    sourceZipPath?: string | null;
    sourceZipHash?: string | null;
  }): Promise<DesignSystemSession> {
    const created = await this.sessions.repository.createSession({
      kind: 'design',
      scope: input.scope,
      owner_project_id: input.ownerProjectId,
      linked_projects: input.linkedProjects,
      parent_session_id: input.parentSessionId,
      title: input.metadata.name,
      status: 'idle',
      metadata: {
        design: metadataJson(input.metadata),
      },
      state: {
        extra: {
          design: { pipelineJson: null },
        },
      },
    });
    try {
      if (input.sourceZipPath) {
        const bytes = await readFile(input.sourceZipPath);
        await this.setSourceZip(
          created.session.id,
          bytes,
          input.sourceZipHash ?? null,
        );
      }
      return (await this.getSession(created.session.id))!;
    } catch (error) {
      await this.sessions.repository
        .trashSession(created.location)
        .catch(() => undefined);
      throw error;
    }
  }

  async createSession(
    input: CreateDsSessionInput,
  ): Promise<DesignSystemSession> {
    await this.sessions.ensureCatalog();
    const parentId = asSessionId(String(input.company_session_id));
    const parent = this.sessions.catalog.get(parentId);
    if (!parent || parent.session.kind !== 'company') {
      throw new Error(
        `Company session ${String(input.company_session_id)} not found`,
      );
    }
    return this.createBundle({
      scope: parent.location.scope,
      ownerProjectId: parent.session.owner_project_id,
      linkedProjects: parent.session.linked_projects,
      parentSessionId: parent.session.id,
      metadata: {
        kind: 'company',
        name: input.name,
        packageName: input.package_name,
        stack: input.stack,
        sourceZipHash: input.source_zip_hash ?? null,
        sourceZipRef: null,
        nextBumpHint: 'patch',
        mcpServerConfigId: null,
        mode: 'creative',
      },
      sourceZipPath: input.source_zip_path,
      sourceZipHash: input.source_zip_hash,
    });
  }

  createStudioSession(
    input: CreateDsStudioSessionInput,
  ): Promise<DesignSystemSession> {
    return this.createBundle({
      scope: { kind: 'project', project_id: input.project_id },
      ownerProjectId: input.project_id,
      linkedProjects: [{ project_id: input.project_id }],
      parentSessionId: null,
      metadata: {
        kind: 'studio',
        name: input.name,
        packageName: input.package_name,
        stack: input.stack,
        sourceZipHash: input.source_zip_hash ?? null,
        sourceZipRef: null,
        nextBumpHint: 'patch',
        mcpServerConfigId: null,
        mode: input.mode ?? 'creative',
      },
      sourceZipPath: input.source_zip_path,
      sourceZipHash: input.source_zip_hash,
    });
  }

  async setSourceZip(
    sessionId: DesignSystemSessionId | string,
    bytes: Uint8Array,
    expectedHash: string | null = null,
  ): Promise<DesignSystemSession> {
    const entry = await this.requireEntry(sessionId);
    const artifacts = await this.sessions.repository.artifactStore(
      entry.location,
    );
    const ref = await artifacts.put({
      kind: 'attachment',
      data: bytes,
      media_type: 'application/zip',
      logical_name: 'design-source.zip',
    });
    if (
      expectedHash != null &&
      expectedHash.toLowerCase() !== ref.sha256
    ) {
      throw new Error(
        `Design source hash mismatch: expected ${expectedHash}, got ${ref.sha256}`,
      );
    }
    await this.updateMetadata(entry, {
      sourceZipHash: ref.sha256,
      sourceZipRef: ref,
    });
    return (await this.getSession(entry.session.id))!;
  }

  private async updateMetadata(
    entry: CatalogEntry,
    patch: Partial<DesignMetadata>,
  ): Promise<void> {
    const next = { ...metadataFromEntry(entry), ...patch };
    await this.sessions.repository.updateSession(entry.location, (session) => ({
      ...session,
      metadata: {
        ...session.metadata,
        design: metadataJson(next),
      },
    }));
  }

  async setPipelineJson(
    sessionId: DesignSystemSessionId | string,
    json: string | null,
  ): Promise<DesignSystemSession> {
    const entry = await this.requireEntry(sessionId);
    await this.sessions.repository.updateState(entry.location, (state) => ({
      ...state,
      extra: {
        ...state.extra,
        design: { pipelineJson: json },
      },
    }));
    return (await this.getSession(entry.session.id))!;
  }

  async getSession(
    id: DesignSystemSessionId | string,
  ): Promise<DesignSystemSession | null> {
    const entry = await this.entry(id);
    return entry ? sessionFromEntry(entry) : null;
  }

  async getSessionByCompanySessionId(
    companySessionId: CompanySessionId | string,
  ): Promise<DesignSystemSession | null> {
    const wanted = String(companySessionId);
    const entry = (await this.designEntries()).find(
      (candidate) =>
        metadataFromEntry(candidate).kind === 'company' &&
        String(candidate.session.parent_session_id) === wanted,
    );
    return entry ? sessionFromEntry(entry) : null;
  }

  async getSessionByProjectId(
    projectId: ProjectId,
  ): Promise<DesignSystemSession | null> {
    const entry = (await this.designEntries()).find(
      (candidate) =>
        metadataFromEntry(candidate).kind === 'studio' &&
        candidate.session.owner_project_id === projectId,
    );
    return entry ? sessionFromEntry(entry) : null;
  }

  async listSessions(): Promise<DesignSystemSession[]> {
    return (await this.designEntries()).map(sessionFromEntry);
  }

  async setNextBumpHint(
    sessionId: DesignSystemSessionId | string,
    hint: DsBumpHint,
  ): Promise<DesignSystemSession> {
    const entry = await this.requireEntry(sessionId);
    await this.updateMetadata(entry, { nextBumpHint: hint });
    return (await this.getSession(entry.session.id))!;
  }

  async setMcpServerConfigId(
    sessionId: DesignSystemSessionId | string,
    configId: string | null,
  ): Promise<DesignSystemSession> {
    const entry = await this.requireEntry(sessionId);
    await this.updateMetadata(entry, { mcpServerConfigId: configId });
    return (await this.getSession(entry.session.id))!;
  }

  async deleteSession(
    id: DesignSystemSessionId | string,
  ): Promise<boolean> {
    const entry = await this.entry(id);
    if (!entry) return false;
    await this.sessions.repository.trashSession(entry.location);
    this.repositories.delete(String(entry.session.id));
    for (const [recordId, owner] of this.versionOwners) {
      if (owner === entry.session.id) this.versionOwners.delete(recordId);
    }
    for (const [recordId, owner] of this.componentOwners) {
      if (owner === entry.session.id) this.componentOwners.delete(recordId);
    }
    return true;
  }

  async createVersion(
    input: CreateDsVersionInput,
  ): Promise<DesignSystemVersion> {
    const entry = await this.requireEntry(input.ds_session_id);
    const record = await this.repository(entry).createVersion(
      String(entry.session.id),
      {
        data: {
          semver: input.semver,
          bumpKind: input.bump_kind,
          isAutoBump: input.is_auto_bump ?? false,
          status: input.status ?? 'draft',
          sourceHash: input.source_hash ?? null,
          tarballRef: null,
          manifestJson: null,
          mcpManifestJson: null,
          docsMarkdown: null,
          storybookPath: null,
          error: null,
          publishedAt: null,
        },
      },
    );
    this.versionOwners.set(record.id, entry.session.id);
    return versionFromRecord(entry, record);
  }

  private async locateVersion(
    id: DesignSystemVersionId | string,
  ): Promise<{
    entry: CatalogEntry;
    record: EntityRecord<DesignVersionData>;
  } | null> {
    const normalized = assertUuid(String(id), 'Design System version id');
    const cachedOwner = this.versionOwners.get(normalized);
    if (cachedOwner) {
      const entry = await this.entry(cachedOwner);
      if (entry) {
        const record = await this.repository(entry).getVersion(normalized);
        if (record) return { entry, record };
      }
      this.versionOwners.delete(normalized);
    }
    for (const entry of await this.designEntries()) {
      const record = await this.repository(entry).getVersion(normalized);
      if (!record) continue;
      this.versionOwners.set(normalized, entry.session.id);
      return { entry, record };
    }
    return null;
  }

  async getVersion(
    id: DesignSystemVersionId | string,
  ): Promise<DesignSystemVersion | null> {
    const found = await this.locateVersion(id);
    return found
      ? versionFromRecord(found.entry, found.record)
      : null;
  }

  async getVersionBySemver(
    sessionId: DesignSystemSessionId | string,
    semver: string,
  ): Promise<DesignSystemVersion | null> {
    return (await this.listVersions(sessionId)).find(
      (version) => version.semver === semver,
    ) ?? null;
  }

  async getLatestPublishedVersion(
    sessionId: DesignSystemSessionId | string,
  ): Promise<DesignSystemVersion | null> {
    return (await this.listVersions(sessionId)).find(
      (version) => version.status === 'published',
    ) ?? null;
  }

  async getLatestVersionAny(
    sessionId: DesignSystemSessionId | string,
  ): Promise<DesignSystemVersion | null> {
    return (await this.listVersions(sessionId))[0] ?? null;
  }

  async listVersions(
    sessionId: DesignSystemSessionId | string,
  ): Promise<DesignSystemVersion[]> {
    const entry = await this.requireEntry(sessionId);
    const records = await this.repository(entry).listVersions();
    for (const record of records) {
      this.versionOwners.set(record.id, entry.session.id);
    }
    return [...records]
      .sort((left, right) => right.seq - left.seq)
      .map((record) => versionFromRecord(entry, record));
  }

  async updateVersion(
    id: DesignSystemVersionId | string,
    patch: UpdateDsVersionArtifacts,
  ): Promise<DesignSystemVersion> {
    const found = await this.locateVersion(id);
    if (!found) {
      throw new Error(`Design System version ${String(id)} not found`);
    }
    const current = found.record.data;
    const has = (key: keyof UpdateDsVersionArtifacts): boolean =>
      Object.prototype.hasOwnProperty.call(patch, key);
    let tarballRef = current.tarballRef;
    if (has('tarball_path')) {
      if (patch.tarball_path == null) {
        tarballRef = null;
      } else {
        const artifacts = await this.sessions.repository.artifactStore(
          found.entry.location,
        );
        tarballRef = await artifacts.put({
          kind: 'attachment',
          data: await readFile(patch.tarball_path),
          media_type: 'application/gzip',
          logical_name: basename(patch.tarball_path),
        });
      }
    }
    const data: DesignVersionData = {
      ...current,
      ...(has('semver') ? { semver: patch.semver! } : {}),
      ...(has('bump_kind') ? { bumpKind: patch.bump_kind! } : {}),
      ...(has('is_auto_bump')
        ? { isAutoBump: patch.is_auto_bump! }
        : {}),
      ...(has('status') ? { status: patch.status! } : {}),
      ...(has('source_hash') ? { sourceHash: patch.source_hash ?? null } : {}),
      tarballRef,
      ...(has('manifest_json') ? { manifestJson: patch.manifest_json ?? null } : {}),
      ...(has('mcp_manifest_json')
        ? { mcpManifestJson: patch.mcp_manifest_json ?? null }
        : {}),
      ...(has('docs_md') ? { docsMarkdown: patch.docs_md ?? null } : {}),
      ...(has('storybook_path')
        ? { storybookPath: patch.storybook_path ?? null }
        : {}),
      ...(has('error') ? { error: patch.error ?? null } : {}),
      ...(patch.markPublished
        ? {
            status: has('status') ? patch.status! : 'published',
            publishedAt: new Date().toISOString(),
          }
        : {}),
    };
    const updated = await this.repository(found.entry).updateVersion(
      found.record.id,
      { data },
    );
    return versionFromRecord(found.entry, updated);
  }

  async createComponent(
    input: CreateDsComponentInput,
  ): Promise<DesignSystemComponent> {
    const found = await this.locateVersion(input.version_id);
    if (!found) {
      throw new Error(
        `Design System version ${String(input.version_id)} not found`,
      );
    }
    const record = await this.repository(found.entry).createComponent({
      data: {
        versionId: String(input.version_id),
        name: input.name,
        componentKind: input.kind,
        propsSchemaJson: input.props_schema_json ?? null,
        exampleCode: input.example_code ?? null,
      },
    });
    this.componentOwners.set(record.id, found.entry.session.id);
    return componentFromRecord(record);
  }

  private async locateComponent(
    id: DesignSystemComponentId | string,
  ): Promise<{
    entry: CatalogEntry;
    record: EntityRecord<DesignComponentData>;
  } | null> {
    const normalized = assertUuid(String(id), 'Design System component id');
    const cachedOwner = this.componentOwners.get(normalized);
    if (cachedOwner) {
      const entry = await this.entry(cachedOwner);
      if (entry) {
        const record = await this.repository(entry).getComponent(normalized);
        if (record) return { entry, record };
      }
      this.componentOwners.delete(normalized);
    }
    for (const entry of await this.designEntries()) {
      const record = await this.repository(entry).getComponent(normalized);
      if (!record) continue;
      this.componentOwners.set(normalized, entry.session.id);
      return { entry, record };
    }
    return null;
  }

  async getComponent(
    id: DesignSystemComponentId | string,
  ): Promise<DesignSystemComponent | null> {
    const found = await this.locateComponent(id);
    return found ? componentFromRecord(found.record) : null;
  }

  async listComponents(
    versionId: DesignSystemVersionId | string,
  ): Promise<DesignSystemComponent[]> {
    const found = await this.locateVersion(versionId);
    if (!found) return [];
    const records = await this.repository(found.entry).listComponents(
      String(versionId),
    );
    for (const record of records) {
      this.componentOwners.set(record.id, found.entry.session.id);
    }
    return records
      .map(componentFromRecord)
      .sort((left: DesignSystemComponent, right: DesignSystemComponent) =>
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name),
      );
  }

  async getComponentByName(
    versionId: DesignSystemVersionId | string,
    name: string,
  ): Promise<DesignSystemComponent | null> {
    return (await this.listComponents(versionId)).find(
      (component) => component.name === name,
    ) ?? null;
  }
}
