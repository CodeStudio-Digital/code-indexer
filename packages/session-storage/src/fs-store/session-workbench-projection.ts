import { createHash } from 'node:crypto';
import type { CatalogEntry } from '@mcp/session-storage';
import type { FsCoderSession } from './types.js';
import type { FsSessionGroup } from './operational-types.js';

export type FsSessionWorkbenchScope = 'project' | 'global';
export type FsSessionWorkbenchGroupBy = 'group' | 'workspace';

export interface FsSessionWorkbenchListInput {
  scope: FsSessionWorkbenchScope;
  projectId?: number;
  offset: number;
  limit: number;
  query?: string;
  archived?: boolean;
  favorite?: boolean;
  status?: string;
  provider?: string;
  groupBy: FsSessionWorkbenchGroupBy;
  expectedRevision?: string;
}

export interface FsSessionWorkbenchGroupProjection {
  id: string;
  label: string;
  kind: 'session-group' | 'workspace' | 'ungrouped';
  totalCount: number;
  activeCount: number;
  errorCount: number;
}

export interface FsSessionWorkbenchPageProjection {
  sessions: FsCoderSession[];
  groups: FsSessionWorkbenchGroupProjection[];
  totalCount: number;
  nextOffset: number | null;
  queryRevision: string;
  /** Test/telemetry proof that hydration happens only after pagination. */
  hydratedBundleCount: number;
}

export interface FsSessionWorkbenchProjectionSource {
  ensureCatalog(): Promise<void>;
  readonly catalog: { list(): readonly CatalogEntry[] };
  getSession(id: string): Promise<FsCoderSession | null>;
  listGroups(projectId: number): Promise<readonly FsSessionGroup[]>;
}

export class FsSessionWorkbenchProjectionError extends Error {
  constructor(
    readonly code: 'stale_cursor' | 'invalid_offset' | 'projection_changed',
    message: string,
  ) {
    super(message);
  }
}

interface Candidate {
  entry: CatalogEntry;
  id: string;
  title: string;
  provider: string;
  model: string;
  status: string;
  archived: boolean;
  favorite: boolean;
  groupId: string | null;
  workspaceId: string;
  workspaceLabel: string;
  createdAt: string;
  updatedAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function latestTimestamp(...values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === 'string')
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date(0).toISOString();
}

function linkedProjectLabels(entry: CatalogEntry): Array<{
  projectId: number;
  label: string;
  primary: boolean;
}> {
  const coder = record(entry.session.metadata.coder);
  const rawLinks = Array.isArray(coder.linked_projects) ? coder.linked_projects : [];
  const links = rawLinks.flatMap((raw) => {
    const link = record(raw);
    const projectId = Number(link.project_id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return [];
    const label = typeof link.name === 'string' && link.name.trim()
      ? link.name.trim()
      : typeof link.label === 'string' && link.label.trim()
        ? link.label.trim()
        : `Project ${projectId}`;
    return [{ projectId, label, primary: link.is_primary === true }];
  });
  if (links.length > 0) return links;
  return entry.session.linked_projects.map((link, index) => ({
    projectId: link.project_id,
    label: `Project ${link.project_id}`,
    primary: link.project_id === entry.session.owner_project_id || index === 0,
  }));
}

function toCandidate(entry: CatalogEntry): Candidate {
  const state = entry.state;
  const runtime = record(state?.extra.runtime);
  const groupId = validUuid(runtime.group_id) ? runtime.group_id.toLowerCase() : null;
  const links = linkedProjectLabels(entry);
  const primary = links.find((link) => link.primary) ?? links[0];
  return {
    entry,
    id: entry.session.id,
    title: entry.session.title?.trim() ?? '',
    provider: entry.session.provider?.trim() ?? '',
    model: entry.session.model?.trim() ?? '',
    status: state?.status?.trim() || 'idle',
    archived: (state?.archived_at ?? entry.session.archived_at) != null,
    favorite: entry.session.favorite,
    groupId,
    workspaceId: `workspace:${primary?.projectId ?? 'unassigned'}`,
    workspaceLabel: links.map((link) => link.label).join(' + ') || 'Unassigned workspace',
    createdAt: entry.session.created_at,
    updatedAt: latestTimestamp(entry.session.updated_at, state?.updated_at),
  };
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id);
}

function revisionFor(input: FsSessionWorkbenchListInput, candidates: readonly Candidate[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    scope: input.scope,
    projectId: input.projectId ?? null,
    query: input.query ?? null,
    archived: input.archived ?? null,
    favorite: input.favorite ?? null,
    status: input.status ?? null,
    provider: input.provider ?? null,
    groupBy: input.groupBy,
  }));
  for (const candidate of candidates) {
    hash.update('\0');
    hash.update(candidate.id);
    hash.update('\0');
    hash.update(candidate.title);
    hash.update('\0');
    hash.update(candidate.provider);
    hash.update('\0');
    hash.update(candidate.model);
    hash.update('\0');
    hash.update(candidate.workspaceId);
    hash.update('\0');
    hash.update(candidate.workspaceLabel);
    hash.update('\0');
    hash.update(candidate.updatedAt);
    hash.update(candidate.favorite ? '1' : '0');
    hash.update(candidate.archived ? '1' : '0');
    hash.update(candidate.status);
    hash.update(candidate.groupId ?? '');
  }
  return hash.digest('base64url').slice(0, 24);
}

export class FsSessionWorkbenchProjection {
  constructor(private readonly source: FsSessionWorkbenchProjectionSource) {}

  async listPage(input: FsSessionWorkbenchListInput): Promise<FsSessionWorkbenchPageProjection> {
    await this.source.ensureCatalog();
    const groupNames = input.scope === 'project' && input.projectId != null
      ? new Map((await this.source.listGroups(input.projectId)).map((group) => [group.id, group.name]))
      : new Map<string, string>();
    const normalizedQuery = input.query?.trim().toLocaleLowerCase();

    const candidates = this.source.catalog.list()
      .filter((entry) => entry.session.kind === 'coder')
      .filter((entry) => input.scope === 'global'
        ? entry.session.storage_scope.kind === 'global'
        : entry.session.storage_scope.kind === 'project' &&
          entry.session.storage_scope.project_id === input.projectId)
      .map(toCandidate)
      .filter((candidate) => input.archived === undefined || candidate.archived === input.archived)
      .filter((candidate) => input.favorite === undefined || candidate.favorite === input.favorite)
      .filter((candidate) => input.status === undefined || candidate.status === input.status)
      .filter((candidate) => input.provider === undefined || candidate.provider === input.provider)
      .filter((candidate) => {
        if (!normalizedQuery) return true;
        const groupLabel = candidate.groupId ? groupNames.get(candidate.groupId) ?? '' : '';
        return [candidate.title, candidate.provider, candidate.model, candidate.workspaceLabel, groupLabel]
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      })
      .sort(compareCandidates);

    const queryRevision = revisionFor(input, candidates);
    if (input.expectedRevision && input.expectedRevision !== queryRevision) {
      throw new FsSessionWorkbenchProjectionError(
        'stale_cursor',
        'The session list changed after this cursor was issued',
      );
    }
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > candidates.length) {
      throw new FsSessionWorkbenchProjectionError('invalid_offset', 'Cursor offset is outside the result set');
    }

    const pageCandidates = candidates.slice(input.offset, input.offset + input.limit);
    const hydrated = await Promise.all(pageCandidates.map((candidate) => this.source.getSession(candidate.id)));
    if (hydrated.some((session) => session == null)) {
      throw new FsSessionWorkbenchProjectionError(
        'projection_changed',
        'A session changed while the current page was being projected',
      );
    }

    const groups = new Map<string, FsSessionWorkbenchGroupProjection>();
    for (const candidate of candidates) {
      const group = input.groupBy === 'workspace'
        ? {
            id: candidate.workspaceId,
            label: candidate.workspaceLabel,
            kind: 'workspace' as const,
          }
        : candidate.groupId
          ? {
              id: candidate.groupId,
              label: groupNames.get(candidate.groupId) ?? 'Unnamed group',
              kind: 'session-group' as const,
            }
          : { id: 'ungrouped', label: 'Ungrouped', kind: 'ungrouped' as const };
      const current = groups.get(group.id) ?? {
        ...group,
        totalCount: 0,
        activeCount: 0,
        errorCount: 0,
      };
      current.totalCount += 1;
      if (candidate.status === 'running') current.activeCount += 1;
      if (candidate.status === 'error') current.errorCount += 1;
      groups.set(group.id, current);
    }

    const nextOffset = input.offset + pageCandidates.length;
    return {
      sessions: hydrated as FsCoderSession[],
      groups: [...groups.values()],
      totalCount: candidates.length,
      nextOffset: nextOffset < candidates.length ? nextOffset : null,
      queryRevision,
      hydratedBundleCount: hydrated.length,
    };
  }
}
