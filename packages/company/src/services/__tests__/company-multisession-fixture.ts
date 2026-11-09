import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { SessionLocator } from '@mcp/session-storage';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { OperationalSessionFiles } from '@apps/http-api/server/operational-session-files.js';
import { CompanySessionFiles } from '../CompanySessionFiles.js';
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
export async function companyFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'company-family-')); cleanup.push(directory);
  const dataDir = join(directory, 'data'); const projectRoot = join(directory, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  const project = { id: 7, name: 'Synthetic', root_path: projectRoot };
  const locator = new SessionLocator({ dataDir, projectRootResolver: { resolveProjectRoot: id => id === 7 ? projectRoot : null, listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }] } });
  const sessionStore = new FsSessionStore({ locator });
  const db = { getProject: (id: number) => id === 7 ? project : null };
  const operationalSessionFiles = new OperationalSessionFiles({ repository: sessionStore.repository, catalog: sessionStore.catalog, locator, projects: db });
  const company = await operationalSessionFiles.createCompanySession({ name: 'Company', project_ids: [7], config_json: '{"master_provider":"synthetic","master_model":"fixture"}' });
  const child = await operationalSessionFiles.createCompanySession({ name: 'Mission', project_ids: [7], parent_session_id: company.id, config_json: company.config_json });
  const foreign = await operationalSessionFiles.createCompanySession({ name: 'Other company', project_ids: [7] });
  const files = (id: string) => new CompanySessionFiles({ companySessionId: id, sessionStore });
  return { directory, sessionStore, operationalSessionFiles, company, child, foreign, files, db };
}
