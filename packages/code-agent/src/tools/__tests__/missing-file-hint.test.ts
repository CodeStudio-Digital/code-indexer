import { describe, expect, it } from 'vitest';
import type { IFilesystemPort } from '../../ports/filesystem-port.js';
import { missingFileHint } from '../missing-file-hint.js';

describe('missing file hints', () => {
  it('bounds directory enumeration and closes its iterator', async () => {
    let visited = 0;
    let closed = false;
    const fs = {
      async *iterateDirectory() {
        try {
          for (let i = 0; i < 10000; i++) {
            visited++;
            yield { name: `file-${i}.ts`, isDirectory: () => false, isFile: () => true };
          }
        } finally { closed = true; }
      },
    };
    const hint = await missingFileHint(fs, '/authorized');
    expect(visited).toBeLessThanOrEqual(21);
    expect(closed).toBe(true);
    expect(hint).toContain('partial listing');
    expect(hint).not.toContain('file-21.ts');
  });

  it('ignores inaccessible parents and does not fall back to unbounded enumeration', async () => {
    const fs = { readdir: () => { throw new Error('must not run'); } } as unknown as IFilesystemPort;
    expect(await missingFileHint(fs, '/authorized')).toBe('');
    const failing = { async *iterateDirectory() { throw new Error('offline'); yield; } } as unknown as IFilesystemPort;
    expect(await missingFileHint(failing, '/authorized')).toBe('');
  });
});
