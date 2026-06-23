import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@mcp/api-bus';
import type { DesignSystemSession, DesignSystemVersion } from '@mcp/store/design-system-store.js';
import {
  ensureVerdaccioRunning,
  linkDesignSystem,
  linkDsToDir,
  resolveDsForLink,
  unlinkDesignSystem,
  type DsLinkDeps,
  type VerdaccioLike,
} from '../link-design-system.js';

const URL = 'http://127.0.0.1:4873';

function makeSession(over: Partial<DesignSystemSession> = {}): DesignSystemSession {
  return {
    id: 3,
    company_session_id: null,
    project_id: 99,
    kind: 'studio',
    name: 'Acme UI',
    package_name: '@acme/ui',
    stack: 'react-ts',
    source_zip_hash: null,
    source_zip_path: null,
    next_bump_hint: 'patch',
    mcp_server_config_id: null,
    created_at: 'x',
    ...over,
  };
}

function makeVersion(over: Partial<DesignSystemVersion> = {}): DesignSystemVersion {
  return {
    id: 7,
    ds_session_id: 3,
    semver: '1.2.0',
    bump_kind: 'minor',
    is_auto_bump: false,
    status: 'published',
    source_hash: null,
    tarball_path: null,
    manifest_json: null,
    mcp_manifest_json: null,
    docs_md: null,
    storybook_path: null,
    error: null,
    created_at: 'x',
    published_at: 'x',
    ...over,
  };
}

function makeStore(session: DesignSystemSession | null, version: DesignSystemVersion | null) {
  return {
    getSession: vi.fn(() => session),
    getLatestPublishedVersion: vi.fn(() => version),
    getVersionBySemver: vi.fn(() => version),
  };
}

function okVerdaccio(): VerdaccioLike {
  return {
    getEndpoint: vi.fn(async () => ({
      enabled: true,
      status: 'running',
      alive: true,
      loopbackUrl: URL,
      lastError: null,
    })),
    enable: vi.fn(async () => ({ status: 'running', loopbackUrl: URL, lastError: null })),
  };
}

const okRunCmd = () =>
  vi.fn(async (_input: unknown) => ({ ok: true, exitCode: 0, stderrTail: '' }));

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ds-link-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function expectApiError(fn: () => unknown | Promise<unknown>, code: string, status: number) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error(`expected ApiError ${code}, got success`);
      },
      (err) => {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe(code);
        expect((err as ApiError).status).toBe(status);
        return err as ApiError;
      },
    );
}

describe('resolveDsForLink', () => {
  it('throws 404 for an unknown session', async () => {
    await expectApiError(
      () => resolveDsForLink(makeStore(null, null), { dsSessionId: 1, targetStack: 'react-ts' }),
      'not_found',
      404,
    );
  });

  it('throws 400 stack_mismatch naming both stacks', async () => {
    const store = makeStore(makeSession({ stack: 'angular' }), makeVersion());
    const err = await expectApiError(
      () => resolveDsForLink(store, { dsSessionId: 3, targetStack: 'react-ts' }),
      'stack_mismatch',
      400,
    );
    expect(err.message).toContain('angular');
    expect(err.message).toContain('react-ts');
    expect(err.details).toEqual({ dsStack: 'angular', targetStack: 'react-ts' });
  });

  it('throws 409 when nothing is published', async () => {
    await expectApiError(
      () => resolveDsForLink(makeStore(makeSession(), null), { dsSessionId: 3, targetStack: 'react-ts' }),
      'no_published_version',
      409,
    );
  });

  it('throws 409 when the explicit semver is not published', async () => {
    const store = makeStore(makeSession(), makeVersion({ status: 'failed' }));
    await expectApiError(
      () => resolveDsForLink(store, { dsSessionId: 3, semver: '9.9.9', targetStack: 'react-ts' }),
      'no_published_version',
      409,
    );
    expect(store.getVersionBySemver).toHaveBeenCalledWith(3, '9.9.9');
  });

  it('resolves latest published when semver omitted', () => {
    const store = makeStore(makeSession(), makeVersion());
    const { session, version } = resolveDsForLink(store, { dsSessionId: 3, targetStack: 'react-ts' });
    expect(session.package_name).toBe('@acme/ui');
    expect(version.semver).toBe('1.2.0');
    expect(store.getLatestPublishedVersion).toHaveBeenCalledWith(3);
  });
});

describe('ensureVerdaccioRunning', () => {
  it('returns the loopback url when running and alive', async () => {
    await expect(ensureVerdaccioRunning(okVerdaccio())).resolves.toBe(URL);
  });

  it('retries enable() once when enabled but dead', async () => {
    const svc: VerdaccioLike = {
      getEndpoint: vi.fn(async () => ({
        enabled: true,
        status: 'stopped',
        alive: false,
        loopbackUrl: URL,
        lastError: null,
      })),
      enable: vi.fn(async () => ({ status: 'running', loopbackUrl: URL, lastError: null })),
    };
    await expect(ensureVerdaccioRunning(svc)).resolves.toBe(URL);
    expect(svc.enable).toHaveBeenCalledTimes(1);
  });

  it('throws 409 without enabling when operator-disabled', async () => {
    const svc: VerdaccioLike = {
      getEndpoint: vi.fn(async () => ({
        enabled: false,
        status: 'stopped',
        alive: false,
        loopbackUrl: URL,
        lastError: 'off',
      })),
      enable: vi.fn(async () => ({ status: 'running', loopbackUrl: URL, lastError: null })),
    };
    await expectApiError(() => ensureVerdaccioRunning(svc), 'verdaccio_unavailable', 409);
    expect(svc.enable).not.toHaveBeenCalled();
  });

  it('throws 503 when the service is not wired', async () => {
    await expectApiError(() => ensureVerdaccioRunning(null), 'verdaccio_unwired', 503);
  });
});

function makeDeps(builderJson: string | null, store = makeStore(makeSession(), makeVersion())): {
  deps: DsLinkDeps;
  updateProject: ReturnType<typeof vi.fn>;
  dir: string;
} {
  const dir = tempDir();
  const updateProject = vi.fn();
  const deps: DsLinkDeps = {
    db: {
      getProject: (id: number) => (id === 1 ? { id: 1, root_path: dir, builder_json: builderJson } : null),
      updateProject,
    },
    designSystemStore: store,
  };
  return { deps, updateProject, dir };
}

describe('linkDsToDir', () => {
  it('writes the scoped .npmrc line and installs the exact pin', async () => {
    const { deps, dir } = makeDeps(null);
    const runCmd = okRunCmd();
    const link = await linkDsToDir(deps, {
      targetDir: dir,
      dsSessionId: 3,
      targetStack: 'react-ts',
      verdaccio: okVerdaccio(),
      runCmd,
    });
    expect(link).toMatchObject({ sessionId: 3, packageName: '@acme/ui', semver: '1.2.0' });
    expect(typeof link.linkedAt).toBe('string');
    expect(readFileSync(join(dir, '.npmrc'), 'utf-8')).toBe(`@acme:registry=${URL}\n`);
    const call = runCmd.mock.calls[0][0] as { program: string; args: string[]; cwd: string };
    expect(call.program).toBe('npm');
    expect(call.cwd).toBe(dir);
    expect(call.args).toEqual(
      expect.arrayContaining(['install', '@acme/ui@1.2.0', '--save-exact']),
    );
    expect(call.args).not.toContain('--registry'); // scoped → npmrc handles it
  });

  it('throws ds_install_failed when npm fails', async () => {
    const { deps, dir } = makeDeps(null);
    const runCmd = vi.fn(async (_input: unknown) => ({ ok: false, exitCode: 7, stderrTail: 'E401 boom' }));
    const err = await expectApiError(
      () =>
        linkDsToDir(deps, {
          targetDir: dir,
          dsSessionId: 3,
          targetStack: 'react-ts',
          verdaccio: okVerdaccio(),
          runCmd,
        }),
      'ds_install_failed',
      500,
    );
    expect(err.message).toContain('E401 boom');
  });
});

describe('linkDesignSystem', () => {
  it('rejects non-builder projects and DS workspaces', async () => {
    const a = makeDeps(null);
    await expectApiError(
      () => linkDesignSystem(a.deps, { projectId: 1, dsSessionId: 3 }, undefined, { verdaccio: okVerdaccio(), runCmd: okRunCmd() }),
      'not_builder',
      400,
    );
    const b = makeDeps(JSON.stringify({ stack: 'react-ts', kind: 'ds', packageName: '@acme/ds' }));
    await expectApiError(
      () => linkDesignSystem(b.deps, { projectId: 1, dsSessionId: 3 }, undefined, { verdaccio: okVerdaccio(), runCmd: okRunCmd() }),
      'ds_workspace',
      400,
    );
  });

  it('uses the project stack for the mismatch gate', async () => {
    const { deps } = makeDeps(
      JSON.stringify({ stack: 'react-ts', port: 5181 }),
      makeStore(makeSession({ stack: 'vue-ts' }), makeVersion()),
    );
    await expectApiError(
      () => linkDesignSystem(deps, { projectId: 1, dsSessionId: 3 }, undefined, { verdaccio: okVerdaccio(), runCmd: okRunCmd() }),
      'stack_mismatch',
      400,
    );
  });

  it('merges the link into builder_json preserving stack/port', async () => {
    const { deps, updateProject } = makeDeps(JSON.stringify({ stack: 'react-ts', port: 5181 }));
    const out = await linkDesignSystem(deps, { projectId: 1, dsSessionId: 3 }, undefined, {
      verdaccio: okVerdaccio(),
      runCmd: okRunCmd(),
    });
    expect(out.ok).toBe(true);
    expect(updateProject).toHaveBeenCalledTimes(1);
    const written = JSON.parse(updateProject.mock.calls[0][1].builder_json as string);
    expect(written.stack).toBe('react-ts');
    expect(written.port).toBe(5181);
    expect(written.designSystem).toMatchObject({ sessionId: 3, packageName: '@acme/ui', semver: '1.2.0' });
  });

  it('404s on unknown project', async () => {
    const { deps } = makeDeps(null);
    await expectApiError(() => linkDesignSystem(deps, { projectId: 2, dsSessionId: 3 }), 'not_found', 404);
  });
});

describe('unlinkDesignSystem', () => {
  it('throws 400 when no link exists', async () => {
    const { deps } = makeDeps(JSON.stringify({ stack: 'react-ts', port: 5181 }));
    await expectApiError(() => unlinkDesignSystem(deps, { projectId: 1 }), 'not_linked', 400);
  });

  it('uninstalls, drops the npmrc line and clears builder_json.designSystem', async () => {
    const builderJson = JSON.stringify({
      stack: 'react-ts',
      port: 5181,
      designSystem: { sessionId: 3, packageName: '@acme/ui', semver: '1.2.0', linkedAt: 'x' },
    });
    const { deps, updateProject, dir } = makeDeps(builderJson);
    writeFileSync(join(dir, '.npmrc'), `fund=false\n@acme:registry=${URL}\n`, 'utf-8');
    const runCmd = okRunCmd();
    const out = await unlinkDesignSystem(deps, { projectId: 1 }, undefined, { runCmd });
    expect(out.ok).toBe(true);
    const call = runCmd.mock.calls[0][0] as { args: string[] };
    expect(call.args).toEqual(expect.arrayContaining(['uninstall', '@acme/ui']));
    expect(readFileSync(join(dir, '.npmrc'), 'utf-8')).toBe('fund=false\n');
    const written = JSON.parse(updateProject.mock.calls[0][1].builder_json as string);
    expect(written.designSystem).toBeUndefined();
    expect(written.stack).toBe('react-ts');
  });
});
