import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeDocumentReader } from '../native-document-reader.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-document-'));
  roots.push(root);
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  await mkdir(project); await mkdir(outside);
  await writeFile(join(project, 'local.txt'), 'local');
  await writeFile(join(outside, 'granted.txt'), 'granted');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  return { root, project, outside };
}
const document = (path: string) => ({ type: 'document' as const, name: 'fixture.txt', mediaType: 'text/plain', path });

describe('native document authorization', () => {
  it('reads project files and exact attachment grants without granting sibling files', async () => {
    const { project, outside } = await fixture();
    const granted = join(outside, 'granted.txt');
    const read = createNativeDocumentReader({ cwd: project, projectName: 'fixture',
      externalRoots: [{ id: 'attachment', rootPath: granted, access: 'read' }] }, 1024);
    expect(Buffer.from(await read(document('local.txt'))).toString()).toBe('local');
    expect(Buffer.from(await read(document(granted))).toString()).toBe('granted');
    await expect(read(document(join(outside, 'secret.txt')))).rejects.toThrow('access denied');
    await expect(read(document('../outside/granted.txt'))).rejects.toThrow('access denied');
  });

  it('rejects project junction escapes, oversize files and cancelled reads', async () => {
    const { project, outside } = await fixture();
    await symlink(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const read = createNativeDocumentReader({ cwd: project, projectName: 'fixture' }, 4);
    await expect(read(document('escape/secret.txt'))).rejects.toThrow('escapes');
    await expect(read(document('local.txt'))).rejects.toThrow('read budget');
    const cancelled = new AbortController(); cancelled.abort(new Error('cancel document'));
    await expect(read(document('local.txt'), cancelled.signal)).rejects.toThrow('cancel document');
  });

  it('reads a bounded file across chunks under a linked project grant', async () => {
    const { project, outside } = await fixture();
    const expected = Buffer.alloc(300_000, 7);
    await writeFile(join(outside, 'large.bin'), expected);
    const read = createNativeDocumentReader({ cwd: project, projectName: 'fixture', globalWorkspace: {
      projects: [{ projectId: 1, rootPath: outside, slug: 'linked', name: 'linked', isPrimary: false }],
    } }, expected.length);
    expect(Buffer.from(await read(document('linked/large.bin')))).toEqual(expected);
  });
});
