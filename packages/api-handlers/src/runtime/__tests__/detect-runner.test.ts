import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { detectRuntimes } from '../detect-runner.js';
import { listFor } from '../detect-all.js';

/**
 * These spawn a real worker thread. That is the point: typechecking proves
 * nothing about `workerSpec()` resolving the right entry under tsx, which is
 * exactly the thing that silently breaks (see workerFileResolution.ts).
 */
describe('detectRuntimes', () => {
  it('returns the same result off-thread as in-process', async () => {
    const dir = tmpdir();
    const viaWorker = await detectRuntimes('node', dir);
    expect(viaWorker).toEqual(listFor('node', dir));
  }, 60_000);

  it('propagates an unknown kind as a 400 instead of hanging', async () => {
    await expect(
      detectRuntimes('nope' as Parameters<typeof detectRuntimes>[0], tmpdir()),
    ).rejects.toMatchObject({ code: 'unsupported', status: 400 });
  }, 60_000);

  it('honours the MCP_RUNTIME_DETECT_WORKER=0 kill-switch', async () => {
    vi.stubEnv('MCP_RUNTIME_DETECT_WORKER', '0');
    try {
      const dir = tmpdir();
      expect(await detectRuntimes('node', dir)).toEqual(listFor('node', dir));
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
