import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  atomicWriteFile,
  durableRename,
} from '../atomic-file.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-atomic-fault-'));
  roots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('atomic filesystem fault boundaries', () => {
  it('revalidates authority after temp fsync and preserves the previous published file on revocation', async () => {
    const root = await temporaryRoot(), target = join(root, 'state.json');
    await writeFile(target, 'previous');
    let revoked = false;
    await expect(atomicWriteFile(target, 'new', {
      faultInjector: ({ point }) => { if (point === 'atomic:after-temp-fsync-before-rename') revoked = true; },
      beforePublish: () => { if (revoked) throw new Error('revoked'); },
    })).rejects.toThrow('revoked');
    expect(await readFile(target, 'utf8')).toBe('previous');
    expect((await readdir(root)).some(name => name.includes('.tmp-'))).toBe(false);
  });
  const writePoints = [
    'atomic:before-temp-write',
    'atomic:after-temp-write-before-fsync',
    'atomic:after-temp-fsync-before-rename',
    'atomic:after-rename-before-directory-fsync',
    'atomic:after-directory-fsync',
  ] as const;

  for (const point of writePoints) {
    it(`leaves a recoverable state at ${point}`, async () => {
      const root = await temporaryRoot();
      const target = join(root, 'state.json');

      await expect(atomicWriteFile(target, '{"ok":true}\n', {
        faultInjector(context) {
          if (context.point === point) throw new Error(`injected ${point}`);
        },
      })).rejects.toThrow(`injected ${point}`);

      const renameCompleted = point === 'atomic:after-rename-before-directory-fsync'
        || point === 'atomic:after-directory-fsync';
      expect(await exists(target)).toBe(renameCompleted);
      if (renameCompleted) {
        expect(await readFile(target, 'utf8')).toBe('{"ok":true}\n');
      }
      expect((await readdir(root)).some((name) => name.includes('.tmp-'))).toBe(false);
    });
  }

  const renamePoints = [
    'atomic:before-rename',
    'atomic:after-rename-before-directory-fsync',
    'atomic:after-target-directory-fsync',
    'atomic:after-directory-fsync',
  ] as const;

  for (const point of renamePoints) {
    it(`keeps durable rename unambiguous at ${point}`, async () => {
      const root = await temporaryRoot();
      const source = join(root, 'source.json');
      const target = join(root, 'target.json');
      await writeFile(source, '{"value":1}\n');

      await expect(durableRename(source, target, {
        faultInjector(context) {
          if (context.point === point) throw new Error(`injected ${point}`);
        },
      })).rejects.toThrow(`injected ${point}`);

      const renameCompleted = point !== 'atomic:before-rename';
      expect(await exists(source)).toBe(!renameCompleted);
      expect(await exists(target)).toBe(renameCompleted);
      if (renameCompleted) {
        expect(await readFile(target, 'utf8')).toBe('{"value":1}\n');
      }
    });
  }
});
