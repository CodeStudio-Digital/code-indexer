/**
 * Phase D2 — the Docs routes must survive a dead sandbox by falling
 * back to the drive mirror (`__docs__/<service>/<path>`) the docs tools
 * maintain, and every payload must carry `origin` so the dashboard can
 * badge provenance.
 *
 * The fixture is filesystem-only: Company session and drive state are
 * persisted in a temporary project bundle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mutable sandbox state — null = dead (no container for the session).
let sandboxBinding: { workdir: string; containerId: string } | null = null;
// When the sandbox is "alive", these drive the fake driver.
let execImpl: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
let readFileImpl: () => Promise<string>;

vi.mock('@mcp/services/sandbox/index.js', () => ({
  getSandboxManager: () => ({
    get: () => sandboxBinding,
    getService: () => sandboxBinding,
  }),
}));

vi.mock('@mcp/services/sandbox/drivers/driver-factory.js', () => ({
  resolveDriver: async () => ({
    exec: () => execImpl(),
    readFile: () => readFileImpl(),
  }),
}));

import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { JsonValue } from '@mcp/session-storage';
import { CompanyDriveStore } from '@mcp/company/services/CompanyDriveStore.js';
import { setCompanyDocCorpus } from '@mcp/company/services/company-doc-corpus.js';
import { CompanyDocs, docVersion, shellQuote } from '@mcp/company/services/CompanyDocs.js';
import { docsTools } from '@mcp/company/tools/docs-tools.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { mountCompanyDocsRoutes } from '../docs.js';
import type { ServerDeps } from '../../../deps.js';

interface Handle {
  app: Hono;
  sessionStore: FsSessionStore;
  sessionId: string;
  dir: string;
}

async function setup(): Promise<Handle> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-docs-routes-'));
  const dataDir = join(dir, 'data');
  const projectRoot = join(dir, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const sessionStore = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [{
        project_id: 7,
        root_path: projectRoot,
      }],
    },
    projectInfoResolver: (projectId) =>
      projectId === 7
        ? { project_id: 7, name: 'Docs', root_path: projectRoot }
        : null,
  });
  const session = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 7 },
    owner_project_id: 7,
    linked_projects: [{ project_id: 7, root_path: projectRoot }],
    title: 'docs-test',
    status: 'idle',
    metadata: {
      company: {
        name: 'docs-test',
        template_id: null,
        runtime_kind: 'company',
        config_json: '{}',
        master_session_id: null,
        project_labels: { 7: null },
        recovered_at: null,
        recovered_reason: null,
      },
    } as unknown as Record<string, JsonValue>,
  });
  await sessionStore.refresh();

  const app = new Hono();
  const deps = { sessionStore } as unknown as ServerDeps;
  mountCompanyDocsRoutes(app, deps);
  return {
    app,
    sessionStore,
    sessionId: session.session.id,
    dir,
  };
}

function teardown(h: Handle): void {
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function seedMirror(h: Handle, path: string, content: string): void {
  const drive = new CompanyDriveStore({
    sessionStore: h.sessionStore,
    companySessionId: h.sessionId,
  });
  drive.write(drive.resolveScopeKey(), `__docs__/main/${path}`, content);
}

describe('company /docs routes — drive-mirror fallback (D2)', () => {
  let h: Handle;
  beforeEach(async () => {
    h = await setup();
    sandboxBinding = null;
    execImpl = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    readFileImpl = async () => { throw new Error('no such file'); };
  });
  afterEach(() => { setCompanyDocCorpus(null); teardown(h); });

  it('list falls back to the mirror when the sandbox is dead', async () => {
    seedMirror(h, 'adr/0001-auth.md', '# ADR 1');
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/docs/list`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: string[]; entries: Array<{ path: string; origin: string; mtime: string | null }> };
    expect(body.items).toContain('adr/0001-auth.md');
    const entry = body.entries.find((e) => e.path === 'adr/0001-auth.md')!;
    expect(entry.origin).toBe('drive_mirror');
    expect(entry.mtime).toBeTruthy();
  });

  it('read falls back to the mirror when the sandbox is dead', async () => {
    seedMirror(h, 'adr/0001-auth.md', '# ADR 1');
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/docs/read?path=${encodeURIComponent('adr/0001-auth.md')}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { content: string; origin: string; mtime: string | null };
    expect(body.content).toBe('# ADR 1');
    expect(body.origin).toBe('drive_mirror');
  });

  it('read falls back to the mirror when the sandbox is alive but lacks the file', async () => {
    sandboxBinding = { workdir: '/work', containerId: 'c1' };
    readFileImpl = async () => { throw new Error('ENOENT'); };
    seedMirror(h, 'runbook.md', '# Runbook');
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/docs/read?path=runbook.md`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { content: string; origin: string };
    expect(body.content).toBe('# Runbook');
    expect(body.origin).toBe('drive_mirror');
  });

  it('durable knowledge wins over a stale sandbox working copy', async () => {
    sandboxBinding = { workdir: '/work', containerId: 'c1' };
    execImpl = async () => ({ stdout: 'runbook.md\n', stderr: '', exitCode: 0 });
    seedMirror(h, 'runbook.md', '# old mirror copy');
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/docs/list`);
    const body = (await r.json()) as { entries: Array<{ path: string; origin: string }> };
    const entries = body.entries.filter((e) => e.path === 'runbook.md');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.origin).toBe('drive_mirror');
  });

  it('read 404s when neither the sandbox nor the mirror has the doc', async () => {
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/docs/read?path=missing.md`,
    );
    expect(r.status).toBe(404);
  });

  it('read rejects traversal paths', async () => {
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/docs/read?path=${encodeURIComponent('../etc/passwd')}`,
    );
    expect(r.status).toBe(400);
  });
  function knowledge(service = 'main') {
    return new CompanyDocs(new CompanyDriveStore({ sessionStore: h.sessionStore, companySessionId: h.sessionId }), service);
  }
  it('tools and HTTP share durable knowledge without any sandbox', async () => {
    const driveStore = new CompanyDriveStore({ sessionStore: h.sessionStore, companySessionId: h.sessionId });
    const ctx = { companyContext: { companySessionId: h.sessionId, orchestrator: { effectiveSessionId: h.sessionId, driveStore } } } as unknown as ToolContext;
    const call = (name: string, args: Record<string, unknown>) => docsTools.find((tool) => tool.name === name)!.handler(args, ctx);
    expect((await call('docs_write', { service: 'api', path: 'auth.md', content: '# OAuth runbook' })).isError).toBeFalsy();
    const listed = await call('docs_list', { service: 'api' });
    expect(String(listed.content)).toContain('auth.md');
    expect(String((await call('docs_search', { service: 'api', query: 'OAuth' })).content)).toContain('OAuth');
    const response = await h.app.request('/api/company/sessions/' + h.sessionId + '/docs/read?service=api&path=auth.md');
    expect(await response.json()).toMatchObject({ content: '# OAuth runbook', version: docVersion('# OAuth runbook') });
    const list = await h.app.request('/api/company/sessions/' + h.sessionId + '/docs/list?service=api');
    expect(await list.json()).toMatchObject({ services: expect.arrayContaining([{ service_id: 'api', name: 'api' }]) });
  });
  it('deleted knowledge cannot return from a stale sandbox copy', async () => {
    await knowledge().write('obsolete.md', 'old');
    await knowledge().delete('obsolete.md');
    sandboxBinding = { workdir: '/app', containerId: 'stale' };
    execImpl = async () => ({ stdout: 'obsolete.md\n', stderr: '', exitCode: 0 });
    readFileImpl = async () => 'old';
    const list = await h.app.request('/api/company/sessions/' + h.sessionId + '/docs/list');
    expect((await list.json() as { items: string[] }).items).not.toContain('obsolete.md');
    const read = await h.app.request('/api/company/sessions/' + h.sessionId + '/docs/read?path=obsolete.md');
    expect(read.status).toBe(404);
  });
  it('rejects stale document versions without overwriting another session', async () => {
    await knowledge().write('decision.md', 'first', {}, null);
    const version = docVersion('first');
    await knowledge().write('decision.md', 'second', {}, version);
    await expect(knowledge().write('decision.md', 'lost update', {}, version)).rejects.toThrow('version conflict');
    expect((await knowledge().read('decision.md'))?.content).toBe('second');
  });
  it('reports sandbox copy failure only after durable save succeeds', async () => {
    const drive = new CompanyDriveStore({ sessionStore: h.sessionStore, companySessionId: h.sessionId });
    const docs = new CompanyDocs(drive, 'main', { containerId: 'fake', workdir: '/app', driver: { writeFile: vi.fn(async () => { throw Error('offline'); }) } } as never);
    expect(await docs.write('runbook.md', 'saved')).toMatchObject({ saved: true, workingCopy: 'failed' });
    expect((await knowledge().read('runbook.md'))?.content).toBe('saved');
  });
  it('counts UTF-8 bytes and safely quotes shell syntax in doc paths', async () => {
    await expect(knowledge().write('big.md', '😀'.repeat(70000))).rejects.toThrow('bytes');
    expect(shellQuote('$(touch danger)')).toBe("'$(touch danger)'");
    expect(() => new CompanyDocs({} as never, '../api')).toThrow('service');
  });
  it('refreshes secrets changed or created by a different store after worker boot', async () => {
    const codec = { encrypt: async (value: string) => 'enc:' + Buffer.from(value).toString('base64'), decrypt: async (value: string) => Buffer.from(value.slice(4), 'base64').toString() };
    const main = new CompanySessionEnvStore(h.sessionStore, codec);
    const worker = new CompanySessionEnvStore(h.sessionStore, codec);
    await main.upsert(h.sessionId, 'TOKEN', 'before', true);
    await worker.initialize();
    expect(worker.get(h.sessionId, 'TOKEN')?.value).toBe('before');
    await main.upsert(h.sessionId, 'TOKEN', 'after', true);
    await main.upsert(h.sessionId, 'NEW_TOKEN', 'new', true);
    expect((await worker.getAsync(h.sessionId, 'TOKEN'))?.value).toBe('after');
    expect((await worker.getAsync(h.sessionId, 'NEW_TOKEN'))?.value).toBe('new');
    expect(worker.listMetadata(h.sessionId).every((row) => row.value === '')).toBe(true);
  });
  it('concurrent async secret creation preserves one key and scope', async () => {
    const codec = { encrypt: async (value: string) => 'enc:' + value, decrypt: async (value: string) => value.slice(4) };
    const first = new CompanySessionEnvStore(h.sessionStore, codec);
    const second = new CompanySessionEnvStore(h.sessionStore, codec);
    await Promise.all([
      first.upsert(h.sessionId, 'TOKEN', 'one', true, { serviceScope: 'api' }),
      second.upsert(h.sessionId, 'TOKEN', 'two', true),
    ]);
    const rows = await first.listAsync(h.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'TOKEN', service_scope: 'api', value: 'two' });
  });

  it('does not write the sandbox or acknowledge a failed durable commit', async () => {
    const writeFile = vi.fn();
    const docs = new CompanyDocs({ resolveScopeKey: () => 'scope', write: () => { throw new Error('disk full'); } } as never, 'main', { containerId: 'fake', workdir: '/app', driver: { writeFile } } as never);
    await expect(docs.write('adr.md', 'decision')).rejects.toThrow('disk full');
    expect(writeFile).not.toHaveBeenCalled();
  });
  it('removes stale RAG chunks when durable knowledge changes or is deleted', async () => {
    const replaceChunksForSource = vi.fn();
    const updateSourceStatus = vi.fn();
    const scope = new CompanyDriveStore({ sessionStore: h.sessionStore, companySessionId: h.sessionId }).resolveScopeKey();
    setCompanyDocCorpus({
      getCollectionByName: () => ({ id: 1 }),
      listSourcesByCollection: () => [{ id: 2, uri: 'companydoc://' + scope + '/main/adr.md' }],
      listVectorIdsForSource: () => [], replaceChunksForSource, updateSourceStatus,
      deleteSemanticItemsByVectorIds: vi.fn(), updateSourceStats: vi.fn(),
    } as never);
    expect(await knowledge().write('adr.md', 'new')).toMatchObject({ rag: 'stale' });
    expect(await knowledge().delete('adr.md')).toMatchObject({ rag: 'stale' });
    expect(replaceChunksForSource.mock.calls).toEqual([[2, []], [2, []]]);
    expect(updateSourceStatus).toHaveBeenCalledTimes(2);
  });

});
