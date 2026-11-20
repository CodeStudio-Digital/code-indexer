import { performance } from 'node:perf_hooks';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { asSessionId, type CatalogEntry } from '@mcp/session-storage';
import type { FsCoderSession } from '@mcp/code-agent/sessions/fs-store/types.js';
import {
  FsSessionWorkbenchProjection,
  type FsSessionWorkbenchProjectionSource,
} from '@mcp/code-agent/sessions/fs-store/session-workbench-projection.js';
import type { ServerDeps } from '../../apps/http-api/server/deps.js';
import { SessionWorkbenchQueryService } from '../../apps/http-api/server/routes/coder/session-workbench/query-service.js';
import { mountSessionWorkbenchRoutes } from '../../apps/http-api/server/routes/coder/session-workbench/routes.js';
import {
  SESSION_WORKBENCH_FIXTURE_SIZES,
  createSessionWorkbenchFixture,
  verifySessionWorkbenchFixture,
} from './fixture.mjs';

interface FixtureSession {
  sessionId: string;
  projectId: number;
  workspaceLabel: string;
  groupId: string | null;
  title: string;
  provider: string;
  model: string;
  status: string;
  archived: boolean;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

function catalogEntry(item: FixtureSession): CatalogEntry {
  const id = asSessionId(item.sessionId);
  return {
    location: {
      session_id: id,
      scope: { kind: 'global' },
      session_root: 'fixture',
      bundle_path: `fixture/${id}`,
    },
    session: {
      schema_version: 1,
      id,
      kind: 'coder',
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      storage_scope: { kind: 'global' },
      owner_project_id: item.projectId,
      linked_projects: [{ project_id: item.projectId, root_path: `D:/fixture/${item.projectId}` }],
      parent_session_id: null,
      provider: item.provider,
      model: item.model,
      title: item.title,
      favorite: item.favorite,
      archived_at: item.archived ? item.updatedAt : null,
      metadata: {
        coder: {
          linked_projects: [{
            project_id: item.projectId,
            name: item.workspaceLabel,
            is_primary: true,
          }],
        },
      },
    },
    state: {
      schema_version: 1,
      status: item.status,
      updated_at: item.updatedAt,
      archived_at: item.archived ? item.updatedAt : null,
      goal: null,
      todos: [],
      permissions: {},
      tools: {},
      compaction: {},
      cursors: {},
      extra: { runtime: { group_id: item.groupId } },
    },
  };
}

function hydratedSession(entry: CatalogEntry): FsCoderSession {
  const metadata = entry.session.metadata.coder as {
    linked_projects: Array<{ project_id: number; name: string; is_primary: boolean }>;
  };
  return {
    id: entry.session.id,
    project_id: entry.session.owner_project_id,
    title: entry.session.title ?? '',
    provider: entry.session.provider ?? '',
    model: entry.session.model ?? '',
    status: entry.state?.status ?? 'idle',
    is_archived: entry.state?.archived_at != null,
    is_favorite: entry.session.favorite,
    group_id: (entry.state?.extra.runtime as { group_id?: string | null } | undefined)?.group_id ?? null,
    linked_projects: metadata.linked_projects.map((project) => ({
      ...project,
      root_path: `D:/fixture/${project.project_id}`,
      label: null,
    })),
    created_at: entry.session.created_at,
    updated_at: entry.state?.updated_at ?? entry.session.updated_at,
  } as FsCoderSession;
}

async function measure(count: number) {
  const fixture = createSessionWorkbenchFixture(count) as FixtureSession[];
  verifySessionWorkbenchFixture(fixture, count);
  const entries = fixture.map(catalogEntry);
  const sessions = new Map(entries.map((entry) => [entry.session.id, hydratedSession(entry)]));
  let hydrationCount = 0;
  const source: FsSessionWorkbenchProjectionSource = {
    ensureCatalog: async () => {},
    catalog: { list: () => entries },
    getSession: async (id) => {
      hydrationCount += 1;
      return sessions.get(asSessionId(id)) ?? null;
    },
    listGroups: async () => [],
  };
  const service = new SessionWorkbenchQueryService(
    new FsSessionWorkbenchProjection(source),
    () => false,
  );
  const app = new HttpRouter();
  mountSessionWorkbenchRoutes(app, {} as ServerDeps, { service });

  const startedAt = performance.now();
  const response = await app.request(
    '/api/coder/session-workbench/sessions?scope=global&group_by=workspace&limit=100',
  );
  const body = await response.text();
  const elapsedMs = performance.now() - startedAt;
  const parsed = JSON.parse(body) as { items: unknown[]; groups: unknown[]; totalCount: number };
  if (response.status !== 200 || parsed.totalCount !== count || parsed.items.length !== 100) {
    throw new Error(`unexpected endpoint result for ${count} sessions`);
  }
  if (hydrationCount !== 100) {
    throw new Error(`expected 100 bundle hydrations, received ${hydrationCount}`);
  }
  return {
    count,
    status: response.status,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    responseBytes: Buffer.byteLength(body),
    returnedItems: parsed.items.length,
    returnedGroups: parsed.groups.length,
    hydratedBundles: hydrationCount,
  };
}

const results = [];
for (const count of SESSION_WORKBENCH_FIXTURE_SIZES) {
  results.push(await measure(count));
}
process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
