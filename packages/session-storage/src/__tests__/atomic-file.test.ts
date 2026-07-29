import { describe, expect, it, vi } from 'vitest';
import { retryTransientRename } from '../atomic-file.js';

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('retryTransientRename', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries transient Windows %s failures with bounded delays',
    async (code) => {
      const operation = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(fsError(code))
        .mockRejectedValueOnce(fsError(code))
        .mockResolvedValue(undefined);
      const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);

      await retryTransientRename(operation, {
        platform: 'win32',
        delaysMs: [10, 25],
        sleep,
      });

      expect(operation).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[10], [25]]);
    },
  );

  it('does not retry a non-transient error', async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(fsError('ENOENT'));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      retryTransientRename(operation, {
        platform: 'win32',
        delaysMs: [10],
        sleep,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry Windows-only errors on other platforms', async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(fsError('EPERM'));

    await expect(
      retryTransientRename(operation, {
        platform: 'linux',
        delaysMs: [10],
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops after the configured retry budget', async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(fsError('EPERM'));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      retryTransientRename(operation, {
        platform: 'win32',
        delaysMs: [10, 25],
        sleep,
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [25]]);
  });
});
