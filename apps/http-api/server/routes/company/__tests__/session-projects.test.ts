import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { createDesignTestHost } from './designer-fixture.js';
import { linkedProjectService } from '../session-projects.js';
import { mountCompanyFileSessionRoutes } from '../session-files.routes.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('links each project once, protects the owner and unlinks the selected session only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'company-project-routes-'));
  roots.push(root);
  const host = await createDesignTestHost(root, { reply: '', changes: {} });
  const app = new HttpRouter();
  mountCompanyFileSessionRoutes(app, { ...host.config, companySandboxServicesStore: {
    get: () => null, listBySessionAll: () => [],
  } as never });
  const parent = await host.sessions.createCompanySession({ name: 'Company', project_ids: [1] });
  const child = await host.sessions.createCompanySession({ name: 'Child', parent_session_id: parent.id, project_ids: [1] });
  const appStudio = await host.sessions.createCompanySession({ name: 'App', runtime_kind: 'app_studio', project_ids: [1] });
  const pathname = (id: string) => '/api/company/sessions/' + id;
  const link = (id: string, projectId: number, label?: string) => app.request(pathname(id) + '/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: projectId, label }),
  });
  const unlink = (id: string, projectId: number) => app.request(pathname(id) + '/projects/' + projectId, { method: 'DELETE' });
  expect((await link(parent.id, 99)).status).toBe(404);
  expect((await link(appStudio.id, 2)).status).toBe(409);
  const simultaneous = await Promise.all([link(parent.id, 2, 'Docs'), link(parent.id, 2, 'Docs')]);
  expect(simultaneous.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await link(child.id, 2)).status).toBe(200);
  const full = await (await app.request(pathname(parent.id))).json();
  expect(full.projects).toEqual([
    expect.objectContaining({ project_id: 1, is_owner: true }),
    expect.objectContaining({ project_id: 2, is_owner: false, is_service: false, label: 'Docs' }),
  ]);
  expect((await unlink(parent.id, 1)).status).toBe(409);
  const sentinel = join(root, 'front', 'keep.txt');
  await writeFile(sentinel, 'preserved');
  expect((await unlink(child.id, 2)).status).toBe(200);
  expect((await host.sessions.getCompanySessionFull(parent.id))?.projects).toHaveLength(2);
  expect((await unlink(parent.id, 2)).status).toBe(200);
  expect((await unlink(parent.id, 2)).status).toBe(404);
  expect(await readFile(sentinel, 'utf8')).toBe('preserved');
});

it('requires a unique project link and a registered service to offer service removal', () => {
  const registered = new Set(['web']);
  expect(linkedProjectService(2, [1, 2], { '1': null, '2': 'web' }, registered)).toBe('web');
  expect(linkedProjectService(2, [1, 2], { '1': 'web', '2': 'web' }, registered)).toBeNull();
  expect(linkedProjectService(2, [1, 2], { '1': null, '2': 'Notes' }, registered)).toBeNull();
});
