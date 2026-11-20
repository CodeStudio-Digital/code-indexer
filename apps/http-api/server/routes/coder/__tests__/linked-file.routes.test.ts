import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../deps.js';
import { mountCoderLinkedFileRoute } from '../linked-file.js';

const id = '11111111-1111-4111-8111-111111111111';
let temp: string, root: string, other: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'codestudio-linked-file-'));
  root = join(temp, 'project');
  other = join(temp, 'second');
  await Promise.all([mkdir(root), mkdir(other)]);
});
afterEach(async () => { await rm(temp, { recursive: true, force: true, maxRetries: 4 }); });

function fixture({ worktree = null, global = false, grant = false }: { worktree?: string | null; global?: boolean; grant?: boolean } = {}) {
  const app = new HttpRouter();
  const projects = [{ id: 1, name: 'First', root_path: root }, { id: 2, name: 'Other', root_path: other }];
  mountCoderLinkedFileRoute(app, {
    db: { getProjectCatalogEntry: (pid: number) => projects.find(p => p.id === pid) },
    sessionStore: {
      getSession: () => ({ project_id: 1, worktree_path: worktree, is_global: global,
        linked_projects: projects.map(p => ({ project_id: p.id, is_primary: p.id === 1, root_path: join(temp, 'stale') })) }),
      listSessionFilesystemRoots: () => grant ? [{ id: 'external', root_path: other, access: 'read' }] : [],
    },
  } as unknown as ServerDeps);
  return (path: string, project = false) => app.request((project ? '/api/projects/1' : '/api/coder/sessions/' + id)
    + '/linked-file?' + new URLSearchParams({ path }));
}

describe('linked files in chats and the editor', () => {
  it('reads local Markdown and TSV, including spaces, accents and an absolute child link', async () => {
    const read = fixture();
    await mkdir(join(root, 'relatório'));
    await writeFile(join(root, 'relatório', 'Meu índice.tsv'), 'item\torigem');
    for (const project of [false, true]) {
      const response = await read('relatório/Meu índice.tsv', project);
      expect(response.status).toBe(200);
      const file = await response.json();
      expect(file).toMatchObject({ content: 'item\torigem', path: 'relatório/Meu índice.tsv', isBinary: false, truncated: false });
      expect((await (await read(file.absolutePath, project)).json()).content).toBe(file.content);
    }
  });

  it('distinguishes missing, directory, outside and unreadable workspace paths', async () => {
    const read = fixture();
    expect(await (await read('missing.md')).json()).toEqual({ error: 'missing' });
    expect(await (await read('.')).json()).toEqual({ error: 'notFile' });
    expect(await (await read('../second/report')).json()).toEqual({ error: 'outside' });
    expect(await (await read('//other/report')).json()).toEqual({ error: 'invalid' });
    expect(await (await fixture({ worktree: join(temp, 'removed') })('README.md')).json()).toEqual({ error: 'workspace' });
  });

  it('uses registered global projects and explicit grants, including canonical directory boundaries', async () => {
    await writeFile(join(other, 'index.tsv'), 'second project');
    await symlink(other, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await fixture()('alias/index.tsv')).status).toBe(403);
    expect((await fixture()(join(other, 'index.tsv'))).status).toBe(403);
    expect(await (await fixture({ global: true })('other/index.tsv')).json()).toMatchObject({ projectId: 2, content: 'second project' });
    expect(await (await fixture({ grant: true })(join(other, 'index.tsv'))).json()).toMatchObject({ projectId: null, content: 'second project' });
  });

  it('opens the copy belonging to the conversation in a real Git worktree', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    git(['init', '-b', 'main']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'fixture']);
    const worktree = join(temp, 'checkout');
    git(['worktree', 'add', '-b', 'feature', worktree]);
    await Promise.all([writeFile(join(root, 'README.md'), 'main'), writeFile(join(worktree, 'README.md'), 'feature')]);
    expect(await (await fixture({ worktree })('README.md')).json()).toMatchObject({ content: 'feature', path: 'README.md' });
    expect(await (await fixture()('README.md')).json()).toMatchObject({ content: 'main', worktreePath: null });
  });

  it('bounds file reads, distinguishes empty files and omits unsupported binary content', async () => {
    const read = fixture();
    await Promise.all([
      writeFile(join(root, 'empty.txt'), ''), writeFile(join(root, 'large.tsv'), 'a'.repeat(1000001)),
      writeFile(join(root, 'binary.dat'), Buffer.from([0, 5, 10])),
    ]);
    expect(await (await read('empty.txt')).json()).toMatchObject({ content: '', size: 0, isBinary: false });
    const large = await (await read('large.tsv')).json();
    expect(large.truncated).toBe(true);
    expect(large.content.length).toBe(1000000);
    expect(await (await read('binary.dat')).json()).toMatchObject({ content: '', isBinary: true });
  });
});
