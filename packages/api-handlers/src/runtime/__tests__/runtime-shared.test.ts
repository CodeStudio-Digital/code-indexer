import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadAndExtract, downloadFile } from '../runtime-shared.js';

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const frames: T[] = [];
  for await (const frame of source) frames.push(frame);
  return frames;
}

describe('runtime download integrity', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each(['sha256', 'sha512'] as const)('accepts a matching %s digest', async (algorithm) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-runtime-digest-'));
    tmps.push(dir);
    const dest = join(dir, 'runtime.bin');
    const payload = Buffer.from('verified runtime payload');
    const expected = createHash(algorithm).update(payload).digest('hex');

    await drain(downloadFile({
      url: `data:application/octet-stream;base64,${payload.toString('base64')}`,
      destFile: dest,
      kind: 'dotnet',
      version: '8.0.100',
      digest: { algorithm, expected },
    }));

    expect(readFileSync(dest)).toEqual(payload);
  });

  it('preserves the previous install and removes partial extraction on checksum failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-runtime-atomic-'));
    tmps.push(dir);
    const dest = join(dir, 'managed', '21.0.7');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'keep.txt'), 'existing installation');

    const install = drain(downloadAndExtract({
      url: 'data:application/zip;base64,bm90LWFuLWFyY2hpdmU=',
      ext: 'zip',
      destDir: dest,
      kind: 'java',
      version: '21.0.7',
      digest: { algorithm: 'sha256', expected: '0'.repeat(64) },
    }));

    await expect(install).rejects.toThrow(/sha256 mismatch/);
    expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('existing installation');
    expect(readdirSync(join(dir, 'managed')).filter((name) => name.startsWith('21.0.7.partial-'))).toEqual([]);
  });
});
