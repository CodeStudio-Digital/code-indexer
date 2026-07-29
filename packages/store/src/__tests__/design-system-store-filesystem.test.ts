import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
  isUuid,
  type ProjectRootResolver,
} from '@mcp/session-storage';
import { DesignSystemStore } from '../design-system-store.js';

const roots: string[] = [];

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'mcp-design-fs-'));
  roots.push(base);
  const dataDir = join(base, 'data');
  const projectRoot = join(base, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  const projectRoots: ProjectRootResolver = {
    resolveProjectRoot: (projectId) => projectId === 1 ? projectRoot : undefined,
    listProjectRoots: () => [{ project_id: 1, root_path: projectRoot }],
  };
  const locator = new SessionLocator({ dataDir, projectRootResolver: projectRoots });
  const repository = new FileSessionRepository({ locator });
  const catalog = new SessionCatalog({ locator, repository });
  const store = new DesignSystemStore({
    repository,
    catalog,
    ensureCatalog: async () => {
      await catalog.refresh();
    },
  });
  return { base, projectRoot, locator, repository, catalog, store };
}

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('DesignSystemStore filesystem authority', () => {
  it('stores the session, source artifact, versions and components in one UUID bundle', async () => {
    const { base, projectRoot, locator, repository, catalog, store } = await fixture();
    const sourceZip = join(base, 'theme.zip');
    await writeFile(sourceZip, Buffer.from('zip-payload'));

    const session = await store.createStudioSession({
      project_id: 1,
      name: 'Acme UI',
      package_name: '@acme/ui',
      stack: 'react-ts',
      mode: 'fidelity',
      source_zip_path: sourceZip,
    });
    expect(isUuid(session.id)).toBe(true);

    const bundle = locator.locate(
      { kind: 'project', project_id: 1 },
      session.id,
    ).bundle_path;
    expect(bundle).toBe(
      join(projectRoot, '.mcp-indexer', 'session', session.id),
    );
    const sessionJson = JSON.parse(
      await readFile(join(bundle, 'session.json'), 'utf8'),
    ) as { kind: string; metadata: { design: { packageName: string } } };
    expect(sessionJson).toMatchObject({
      kind: 'design',
      metadata: { design: { packageName: '@acme/ui' } },
    });
    expect(session.source_zip_path).toContain(join(bundle, 'attachments'));
    await expect(readFile(session.source_zip_path!)).resolves.toEqual(
      Buffer.from('zip-payload'),
    );

    const version = await store.createVersion({
      ds_session_id: session.id,
      semver: 'pending',
      bump_kind: 'initial',
    });
    const component = await store.createComponent({
      version_id: version.id,
      name: 'Button',
      kind: 'atom',
      props_schema_json: '{"type":"object"}',
    });
    expect(isUuid(version.id)).toBe(true);
    expect(isUuid(component.id)).toBe(true);
    await expect(
      stat(join(bundle, 'design', 'versions', `${version.id}.json`)),
    ).resolves.toBeDefined();
    await expect(
      stat(join(bundle, 'design', 'components', `${component.id}.json`)),
    ).resolves.toBeDefined();

    const tarball = join(base, 'acme-ui-1.0.0.tgz');
    await writeFile(tarball, Buffer.from('tarball-payload'));
    const published = await store.updateVersion(version.id, {
      semver: '1.0.0',
      bump_kind: 'initial',
      status: 'published',
      tarball_path: tarball,
      markPublished: true,
    });
    expect(published.semver).toBe('1.0.0');
    expect(published.tarball_path).toContain(join(bundle, 'attachments'));
    await expect(readFile(published.tarball_path!)).resolves.toEqual(
      Buffer.from('tarball-payload'),
    );
    const versionJson = JSON.parse(
      await readFile(
        join(bundle, 'design', 'versions', `${version.id}.json`),
        'utf8',
      ),
    ) as { data: { tarballRef: { relative_path: string } } };
    expect(versionJson.data.tarballRef.relative_path).toMatch(
      /^attachments\//,
    );
    expect(JSON.stringify(versionJson)).not.toContain(tarball);
    expect((await store.getLatestPublishedVersion(session.id))?.id).toBe(
      version.id,
    );
    expect(await store.listComponents(version.id)).toMatchObject([
      { id: component.id, name: 'Button' },
    ]);

    expect(await store.deleteSession(session.id)).toBe(true);
    await expect(stat(bundle)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(join(projectRoot, '.mcp-indexer', 'session', '.trash')))
        .some((name) => name.startsWith(`${session.id}-`)),
    ).toBe(true);

    catalog.close();
    await repository.close();
  });

  it('contains no SQLite access or legacy design table names', async () => {
    const sources = await Promise.all([
      readFile(
        new URL('../design-system-store.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL(
          '../../../company/src/tools/design-system/ds-publish-version.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(
        /better-sqlite3|\.prepare\s*\(|\.exec\s*\(/,
      );
      expect(source).not.toMatch(
        /design_system_(?:sessions|versions|components)/,
      );
    }
  });
});
