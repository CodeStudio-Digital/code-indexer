import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  DS_SOURCE_DIRNAME,
  mountDesignSystemSessionRoutes,
} from '@apps/http-api/server/routes/design-system/sessions.js';

describe('design-system session routes source inventory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-ds-route-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function zipBuffer(entries: Record<string, string>): Buffer {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(entries)) {
      zip.addFile(name, Buffer.from(content, 'utf8'));
    }
    return zip.toBuffer();
  }

  function zipBlobPart(entries: Record<string, string>): ArrayBuffer {
    const buffer = zipBuffer(entries);
    const copy = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(copy).set(buffer);
    return copy;
  }

  function createDeps(projectRootProvider: () => string | null, sessionOverride?: Record<string, unknown>) {
    const dsSession = {
      id: 1,
      company_session_id: 20,
      name: 'Corporate UI',
      package_name: '@acme/corporate-ui',
      stack: 'react-ts',
      source_zip_hash: 'hash',
      source_zip_path: sessionOverride?.source_zip_path ?? join(dir, 'template.zip'),
      next_bump_hint: 'patch',
      mcp_server_config_id: null,
      created_at: '2026-04-28 00:00:00',
      ...sessionOverride,
    };

    return {
      db: {
        createProject: vi.fn((name: string, root_path: string, description: string) => ({
          id: 10,
          name,
          root_path,
          description,
        })),
        getProject: vi.fn((id: number) => ({
          id,
          name: '_design-system_test',
          root_path: projectRootProvider(),
        })),
        raw: vi.fn(),
      },
      companyStore: {
        createCompanySession: vi.fn(() => ({ id: 20 })),
        addProjectToCompanySession: vi.fn(),
        listCompanySessionProjects: vi.fn(() => [{ project_id: 10 }]),
        getCompanySession: vi.fn(() => ({ id: 20, status: 'idle' })),
      },
      designSystemStore: {
        createSession: vi.fn(() => dsSession),
        getSession: vi.fn(() => dsSession),
        listSessions: vi.fn(() => []),
        getLatestPublishedVersion: vi.fn(() => null),
        listVersions: vi.fn(() => []),
        getVersionBySemver: vi.fn(() => null),
        setNextBumpHint: vi.fn(),
        deleteSession: vi.fn(),
        setMcpServerConfigId: vi.fn(),
      },
    } as never;
  }

  it('returns 410 Gone for the retired company creation path', async () => {
    const deps = createDeps(() => null);
    const app = new Hono();
    mountDesignSystemSessionRoutes(app, deps);

    const form = new FormData();
    form.set('name', 'Corporate UI');
    form.set('zip', new File([zipBlobPart({ 'index.html': '<div/>' })], 'template.zip', { type: 'application/zip' }));

    const response = await app.request('/api/design-system/sessions', {
      method: 'POST',
      body: form,
    });
    const body = await response.json() as { error: string };
    expect(response.status).toBe(410);
    expect(body.error).toContain('/api/design-system/studio');
  });

  it('re-extracts a studio session zip into <workspace>/import/ without inventory', async () => {
    const workspaceRoot = join(dir, 'ds-workspace');
    const zipPath = join(dir, 'theme.zip');
    writeFileSync(zipPath, zipBuffer({
      'theme/buttons.html': '<button class="btn btn-primary">Go</button>',
      'theme/styles.css': '.btn{display:inline-block}',
    }));

    const deps = createDeps(() => workspaceRoot, {
      kind: 'studio',
      project_id: 10,
      company_session_id: null,
      source_zip_path: zipPath,
    });
    const app = new Hono();
    mountDesignSystemSessionRoutes(app, deps);

    const response = await app.request('/api/design-system/sessions/1/re-extract', {
      method: 'POST',
    });
    const body = await response.json() as { ok: boolean; inventory: unknown };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    // Studio skips the legacy source inventory entirely.
    expect(body.inventory).toBeNull();
    expect(existsSync(join(workspaceRoot, 'import', 'theme', 'buttons.html'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'source-inventory.json'))).toBe(false);
  });

  it('rewrites source-inventory.json when re-extracting an existing session zip', async () => {
    const projectRoot = join(dir, 'virtual-project');
    const zipPath = join(dir, 'template.zip');
    writeFileSync(zipPath, zipBuffer({
      'dashboard.html': '<table class="table datatable"><tr><td>1</td></tr></table>',
      'assets/datatables.css': '.datatable{width:100%}',
    }));

    const deps = createDeps(() => projectRoot, { source_zip_path: zipPath });
    const app = new Hono();
    mountDesignSystemSessionRoutes(app, deps);

    const response = await app.request('/api/design-system/sessions/1/re-extract', {
      method: 'POST',
    });
    const body = await response.json() as { inventory: { html_pages: number; component_candidates: number } };

    expect(response.status).toBe(200);
    expect(body.inventory.html_pages).toBe(1);
    expect(body.inventory.component_candidates).toBeGreaterThan(0);
    expect(existsSync(join(projectRoot, DS_SOURCE_DIRNAME, 'dashboard.html'))).toBe(true);
    expect(existsSync(join(projectRoot, 'source-inventory.json'))).toBe(true);
    expect(existsSync(join(projectRoot, 'source-inventory', 'dependencies.json'))).toBe(true);
    expect(existsSync(join(projectRoot, 'source-inventory', 'pages.json'))).toBe(true);
    expect(existsSync(join(projectRoot, 'source-inventory', 'styles.json'))).toBe(true);
    expect(existsSync(join(projectRoot, 'source-inventory', 'components.json'))).toBe(true);
    expect(existsSync(join(projectRoot, 'source-inventory', 'warnings.json'))).toBe(true);
  });
});
