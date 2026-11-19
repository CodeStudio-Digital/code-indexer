import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRuntimes } from '../detect-runner.js';
import { listFor } from '../detect-all.js';
import { LocalShellAdapter } from '@mcp/code-agent/ports/shell-port.js';
import { createSystemHandlers } from '../../system/index.js';
import type { HandlerDeps } from '../../types.js';

/**
 * These spawn a real worker thread. That is the point: typechecking proves
 * nothing about `workerSpec()` resolving the right entry under tsx, which is
 * exactly the thing that silently breaks (see workerFileResolution.ts).
 */
describe('detectRuntimes', () => {
  let dir: string;
  let binDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-detection-'));
    // The worker is real, but installed runtimes are a fixture. Probing the
    // host's Node twice can produce different results when a probe times out.
    for (const name of ['PATH', 'ProgramFiles', 'NVM_HOME', 'APPDATA', 'HOME', 'USERPROFILE']) {
      vi.stubEnv(name, join(dir, name));
    }
    binDir = join(dir, 'node', 'v20.11.0');
    mkdirSync(binDir, { recursive: true });
    // Versioned installs derive their version from the directory, without
    // executing this marker file or depending on the machine's Node version.
    writeFileSync(join(binDir, process.platform === 'win32' ? 'node.exe' : 'node'), '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });

  const expected = () => [{
    kind: 'node', id: 'managed:20.11.0', label: 'v20.11.0 (managed)',
    version: '20.11.0', binDir, source: 'managed', isManaged: true,
  }];

  it('returns the same result off-thread as in-process', async () => {
    const viaWorker = await detectRuntimes('node', dir);
    expect(viaWorker).toEqual(expected());
    expect(listFor('node', dir)).toEqual(expected());
  }, 60_000);

  it('propagates an unknown kind as a 400 instead of hanging', async () => {
    await expect(
      detectRuntimes('nope' as Parameters<typeof detectRuntimes>[0], dir),
    ).rejects.toMatchObject({ code: 'unsupported', status: 400 });
  }, 60_000);

  it('honours the MCP_RUNTIME_DETECT_WORKER=0 kill-switch', async () => {
    vi.stubEnv('MCP_RUNTIME_DETECT_WORKER', '0');
    expect(await detectRuntimes('node', dir)).toEqual(expected());
    expect(listFor('node', dir)).toEqual(expected());
  }, 30_000);

  it('shares in-flight host checks off the caller thread and runs a fresh check on demand', async () => {
    const shell = vi.spyOn(LocalShellAdapter.prototype, 'run').mockRejectedValue(new Error('host probe on caller thread'));
    try {
      const api = createSystemHandlers({ config: { dbPath: join(dir, 'index.db') } } as HandlerDeps);
      const ctx = { requestId: 'preflight-regression', signal: new AbortController().signal };
      const first = api.preflight(undefined, ctx);
      expect(api.preflight(undefined, ctx)).toBe(first);
      const report = await first;
      expect(report.checks.map(check => check.id)).toEqual(['podman', 'podman-machine', 'wsl2', 'git', 'disk', 'sandbox-image']);
      const next = api.preflight(undefined, ctx);
      expect(next).not.toBe(first);
      expect((await next).platform).toBe(process.platform);
      expect(shell).not.toHaveBeenCalled();
    } finally {
      shell.mockRestore();
    }
  }, 60_000);
});
