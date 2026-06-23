import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DesignSystemStore } from '@mcp/store/design-system-store.js';

/**
 * Integration tests for the DesignSystemStore. We use a real
 * `CodeIndexDB` (file-backed) so all migrations run including the
 * `company_sessions` parent FK.
 */

function seedSession(db: CodeIndexDB, id: number, name: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db
    .prepare(
      `INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', '{}')`,
    )
    .run(id, name);
}

describe('DesignSystemStore (integration)', () => {
  let dir: string;
  let cdb: CodeIndexDB;
  let store: DesignSystemStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-ds-store-'));
    cdb = new CodeIndexDB(join(dir, 'test.db'));
    seedSession(cdb, 1, 'parent-session');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new DesignSystemStore((cdb as any).db);
  });

  afterEach(() => {
    cdb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and reads sessions', () => {
    const created = store.createSession({
      company_session_id: 1,
      name: 'Acme UI',
      package_name: '@acme/ui',
      stack: 'react-ts',
      source_zip_hash: 'abc123',
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.next_bump_hint).toBe('patch');

    const fetched = store.getSession(created.id);
    expect(fetched?.name).toBe('Acme UI');
    expect(fetched?.stack).toBe('react-ts');

    const byCompany = store.getSessionByCompanySessionId(1);
    expect(byCompany?.id).toBe(created.id);
  });

  it('creates and resolves studio sessions by project', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cdb as any).db
      .prepare(`INSERT INTO projects (id, name, root_path) VALUES (7, 'ds-ws', 'D:/tmp/ds-ws')`)
      .run();
    const created = store.createStudioSession({
      project_id: 7,
      name: 'Acme DS',
      package_name: '@acme/ds',
      stack: 'react-ts',
    });
    expect(created.kind).toBe('studio');
    expect(created.project_id).toBe(7);
    expect(created.company_session_id).toBeNull();

    const byProject = store.getSessionByProjectId(7);
    expect(byProject?.id).toBe(created.id);
    // Legacy lookups continuam funcionando lado a lado.
    expect(store.getSessionByCompanySessionId(1)).toBeNull();
  });

  it('updates next_bump_hint', () => {
    const s = store.createSession({
      company_session_id: 1,
      name: 'X',
      package_name: '@x/ui',
      stack: 'vue-ts',
    });
    const updated = store.setNextBumpHint(s.id, 'minor');
    expect(updated.next_bump_hint).toBe('minor');
  });

  it('creates versions and finds the latest published one', () => {
    const s = store.createSession({
      company_session_id: 1,
      name: 'X',
      package_name: '@x/ui',
      stack: 'angular',
    });

    const v1 = store.createVersion({
      ds_session_id: s.id,
      semver: '1.0.0',
      bump_kind: 'initial',
      status: 'draft',
    });
    expect(v1.status).toBe('draft');
    expect(v1.is_auto_bump).toBe(false);

    // Mark v1 published.
    store.updateVersion(v1.id, {
      status: 'published',
      tarball_path: '/tmp/x-1.0.0.tgz',
      source_hash: 'hash-v1',
      markPublished: true,
    });
    const latestPub = store.getLatestPublishedVersion(s.id);
    expect(latestPub?.id).toBe(v1.id);
    expect(latestPub?.published_at).not.toBeNull();

    // Create a draft v2 — latest published shouldn't change.
    const v2 = store.createVersion({
      ds_session_id: s.id,
      semver: 'pending',
      bump_kind: 'patch',
      status: 'draft',
    });
    expect(store.getLatestPublishedVersion(s.id)?.id).toBe(v1.id);
    expect(store.getLatestVersionAny(s.id)?.id).toBe(v2.id);
  });

  it('persists components per version', () => {
    const s = store.createSession({
      company_session_id: 1,
      name: 'X',
      package_name: '@x/ui',
      stack: 'react-ts',
    });
    const v = store.createVersion({
      ds_session_id: s.id,
      semver: '1.0.0',
      bump_kind: 'initial',
      status: 'draft',
    });

    store.createComponent({
      version_id: v.id,
      name: 'Button',
      kind: 'atom',
      props_schema_json: '{"type":"object"}',
      example_code: '<Button />',
    });
    store.createComponent({
      version_id: v.id,
      name: 'DashboardPage',
      kind: 'page-template',
    });
    const list = store.listComponents(v.id);
    expect(list).toHaveLength(2);
    // Sorted by kind then name → 'atom' < 'page-template'.
    expect(list[0].name).toBe('Button');
    expect(list[1].name).toBe('DashboardPage');
    expect(store.getComponentByName(v.id, 'Button')?.kind).toBe('atom');
  });

  it('skipped status round-trips correctly', () => {
    const s = store.createSession({
      company_session_id: 1,
      name: 'X',
      package_name: '@x/ui',
      stack: 'react-ts',
    });
    const v = store.createVersion({
      ds_session_id: s.id,
      semver: 'pending',
      bump_kind: 'patch',
    });
    const updated = store.updateVersion(v.id, {
      status: 'skipped',
      source_hash: 'unchanged',
    });
    expect(updated.status).toBe('skipped');
    expect(updated.source_hash).toBe('unchanged');
  });
});
