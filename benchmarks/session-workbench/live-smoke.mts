import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { asSessionId } from '@mcp/session-storage';
import type { ServerDeps } from '../../apps/http-api/server/deps.js';
import { mountSessionWorkbenchRoutes } from '../../apps/http-api/server/routes/coder/session-workbench/routes.js';

const SESSION_ID = asSessionId('00000000-0000-4000-8000-000000000001');
const REVISION = 17;

const listResponse = {
  contractVersion: 1 as const,
  items: [],
  groups: [],
  totalCount: 0,
  nextCursor: null,
  queryRevision: 'live-smoke-revision',
};

const bootstrapResponse = {
  contractVersion: 1 as const,
  sessionId: SESSION_ID,
  revision: REVISION,
  session: {
    sessionId: SESSION_ID,
    projectId: 7,
    workspaceLabel: 'Live smoke',
    groupId: null,
    title: 'Live smoke',
    provider: 'openai',
    model: 'gpt-test',
    status: 'idle',
    archived: false,
    favorite: false,
    badges: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
    run: { active: false, waitingForInput: false, startedAt: null, lastEventAt: null },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  capabilities: {
    canShowContext: true,
    canShowExecution: true,
    canShowInsights: true,
    canShowPreview: true,
    canShowDiagram: true,
    canConfigureTools: true,
    canConfigureSkills: true,
    canManageSnapshots: true,
    pluginDestinations: [],
  },
  badges: {
    unreadNotifications: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
    executionErrors: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
    executionWarnings: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
    activeSubagents: { availability: 'pending' as const, reason: 'subagent_projection_pending' as const },
    chapters: { availability: 'available' as const, value: 0 },
    pendingSnapshots: { availability: 'pending' as const, reason: 'snapshot_projection_pending' as const },
    invalidConfiguration: { availability: 'pending' as const, reason: 'configuration_projection_pending' as const },
    highestSeverity: { availability: 'pending' as const, reason: 'event_projection_pending' as const },
  },
  summary: {
    sessionId: SESSION_ID,
    revision: REVISION,
    goal: null,
    tasks: [],
    processes: { availability: 'pending' as const, reason: 'execution_resource_not_loaded' as const },
  },
  resourceRevisions: {
    summary: REVISION,
    context: REVISION,
    execution: REVISION,
    insights: REVISION,
    canvas: REVISION,
    configuration: REVISION,
    navigator: REVISION,
  },
  persistedEventCursor: null,
  linkedProjects: [{
    projectId: 7,
    name: 'Live smoke',
    rootLabel: 'Live smoke',
    primary: true,
    focused: true,
  }],
  focusedProjectId: 7,
};

const contextResponse = {
  sessionId: SESSION_ID,
  revision: REVISION,
  view: 'files' as const,
  files: [],
  pageInfo: { totalCount: 0, nextCursor: null },
};

function assertStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
  }
}

const app = new Hono();
mountSessionWorkbenchRoutes(app, {} as ServerDeps, {
  service: {
    listSessions: async () => listResponse,
    bootstrap: async () => bootstrapResponse,
  },
  resources: {
    context: async () => contextResponse,
    execution: async () => { throw new Error('not exercised by this smoke'); },
    insights: async () => { throw new Error('not exercised by this smoke'); },
    configuration: async () => { throw new Error('not exercised by this smoke'); },
  },
});

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });

try {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('ephemeral HTTP server did not expose an address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const invalid = await fetch(`${baseUrl}/api/coder/session-workbench/sessions?scope=project`);
  assertStatus(invalid, 400, 'invalid query');
  const invalidBody = await invalid.json() as { code?: string };
  if (invalidBody.code !== 'invalid_query') throw new Error('invalid query did not return the public error envelope');

  const list = await fetch(`${baseUrl}/api/coder/session-workbench/sessions?scope=global&limit=100`);
  assertStatus(list, 200, 'session list');
  const listEtag = list.headers.get('etag');
  if (!listEtag) throw new Error('session list did not return an ETag');
  assertStatus(await fetch(`${baseUrl}/api/coder/session-workbench/sessions?scope=global&limit=100`, {
    headers: { 'If-None-Match': listEtag },
  }), 304, 'session list conditional GET');

  const bootstrap = await fetch(`${baseUrl}/api/coder/session-workbench/sessions/${SESSION_ID}/bootstrap`);
  assertStatus(bootstrap, 200, 'bootstrap');
  const bootstrapEtag = bootstrap.headers.get('etag');
  if (!bootstrapEtag) throw new Error('bootstrap did not return an ETag');
  assertStatus(await fetch(`${baseUrl}/api/coder/session-workbench/sessions/${SESSION_ID}/bootstrap`, {
    headers: { 'If-None-Match': bootstrapEtag },
  }), 304, 'bootstrap conditional GET');

  const context = await fetch(`${baseUrl}/api/coder/session-workbench/sessions/${SESSION_ID}/context?view=files`);
  assertStatus(context, 200, 'context resource');
  const contextEtag = context.headers.get('etag');
  if (!contextEtag) throw new Error('context resource did not return an ETag');
  assertStatus(await fetch(`${baseUrl}/api/coder/session-workbench/sessions/${SESSION_ID}/context?view=files`, {
    headers: { 'If-None-Match': contextEtag },
  }), 304, 'context conditional GET');

  process.stdout.write(`${JSON.stringify({
    transport: 'tcp',
    address: '127.0.0.1',
    ephemeralPort: true,
    assertions: {
      structuredInvalidQuery: true,
      sessionList: [200, 304],
      bootstrap: [200, 304],
      context: [200, 304],
    },
  }, null, 2)}\n`);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
