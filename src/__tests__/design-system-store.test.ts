import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
  asCompanySessionId,
  isUuid,
  type CompanySessionId,
  type ProjectRootResolver,
} from '@mcp/session-storage';
import { DesignSystemStore } from '@mcp/store/design-system-store.js';

describe('DesignSystemStore filesystem integration', () => {
  let base: string;
  let repository: FileSessionRepository;
  let catalog: SessionCatalog;
  let store: DesignSystemStore;
  let companySessionId: CompanySessionId;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'mcp-ds-store-'));
    const dataDir = join(base, 'data');
    const projectRoot = join(base, 'project');
    await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
    const roots: ProjectRootResolver = {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : undefined,
      listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
    };
    const locator = new SessionLocator({
      dataDir,
      projectRootResolver: roots,
    });
    repository = new FileSessionRepository({ locator });
    catalog = new SessionCatalog({ locator, repository });
    const company = await repository.createSession({
      kind: 'company',
      scope: { kind: 'project', project_id: 7 },
      owner_project_id: 7,
      linked_projects: [{ project_id: 7 }],
      title: 'parent-session',
    });
    companySessionId = asCompanySessionId(company.session.id);
    store = new DesignSystemStore({
      repository,
      catalog,
      ensureCatalog: async () => {
        await catalog.refresh();
      },
    });
  });

  afterEach(async () => {
    store.close();
    catalog.close();
    await repository.close();
    await rm(base, { recursive: true, force: true });
  });

  it('creates UUID company and studio sessions with mutable bundle state', async () => {
    const companyDesign = await store.createSession({
      company_session_id: companySessionId,
      name: 'Acme UI',
      package_name: '@acme/ui',
      stack: 'react-ts',
    });
    expect(isUuid(companyDesign.id)).toBe(true);
    expect(companyDesign.company_session_id).toBe(companySessionId);
    expect(
      (await store.getSessionByCompanySessionId(companySessionId))?.id,
    ).toBe(companyDesign.id);

    const studio = await store.createStudioSession({
      project_id: 7,
      name: 'Fidelity DS',
      package_name: '@acme/fidelity',
      stack: 'react-ts',
      mode: 'fidelity',
    });
    expect(studio).toMatchObject({
      kind: 'studio',
      project_id: 7,
      company_session_id: null,
      mode: 'fidelity',
      pipeline_json: null,
    });
    const withPipeline = await store.setPipelineJson(
      studio.id,
      '{"v":1,"stages":[]}',
    );
    expect(withPipeline.pipeline_json).toBe('{"v":1,"stages":[]}');
    expect((await store.setNextBumpHint(studio.id, 'minor')).next_bump_hint)
      .toBe('minor');
  });

  it('persists version lifecycle and resolves the latest by entity sequence', async () => {
    const session = await store.createSession({
      company_session_id: companySessionId,
      name: 'X',
      package_name: '@x/ui',
      stack: 'angular',
    });
    const first = await store.createVersion({
      ds_session_id: session.id,
      semver: '1.0.0',
      bump_kind: 'initial',
      status: 'draft',
    });
    const published = await store.updateVersion(first.id, {
      status: 'published',
      source_hash: 'hash-v1',
      markPublished: true,
    });
    expect(published.published_at).not.toBeNull();
    expect((await store.getLatestPublishedVersion(session.id))?.id).toBe(
      first.id,
    );

    const second = await store.createVersion({
      ds_session_id: session.id,
      semver: 'pending',
      bump_kind: 'patch',
    });
    expect((await store.getLatestVersionAny(session.id))?.id).toBe(second.id);
    expect((await store.getLatestPublishedVersion(session.id))?.id).toBe(
      first.id,
    );
    expect(
      await store.updateVersion(second.id, {
        status: 'skipped',
        source_hash: 'unchanged',
      }),
    ).toMatchObject({ status: 'skipped', source_hash: 'unchanged' });
  });

  it('persists independently addressable UUID components per version', async () => {
    const session = await store.createSession({
      company_session_id: companySessionId,
      name: 'X',
      package_name: '@x/ui',
      stack: 'react-ts',
    });
    const version = await store.createVersion({
      ds_session_id: session.id,
      semver: '1.0.0',
      bump_kind: 'initial',
    });
    const button = await store.createComponent({
      version_id: version.id,
      name: 'Button',
      kind: 'atom',
      props_schema_json: '{"type":"object"}',
    });
    await store.createComponent({
      version_id: version.id,
      name: 'DashboardPage',
      kind: 'page-template',
    });
    expect(isUuid(button.id)).toBe(true);
    expect((await store.listComponents(version.id)).map((item) => item.name))
      .toEqual(['Button', 'DashboardPage']);
    expect(
      (await store.getComponentByName(version.id, 'Button'))?.kind,
    ).toBe('atom');
  });
});
