import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { SessionSnapshotService } from '@mcp/services/services/session-snapshots.js';
import { toolSnapshotDiff, toolSnapshotSummary } from '@mcp/services/services/tool-session-snapshots.js';
import { ToolRegistry } from '../../core/registry.js';
import { LocalFilesystemAdapter } from '../filesystem-port.js';
import { SnapshotRecorder, SnapshotRecordingFilesystemPort } from '../snapshot-recording-filesystem-port.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tool-history-'));
  const project = join(root, 'project'); await mkdir(project);
  const open = () => FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: id => id === 7 ? project : null,
    listProjectRoots: () => [{ project_id: 7, root_path: project }],
  } });
  let store = open();
  cleanups.push(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const session = await store.createSession({ project_id: 7, title: 'Tool snapshots', provider: 'test', model: 'test' });
  const user = await store.appendMessage({ session_id: session.id, message: { role: 'user', content: [{ type: 'text', text: 'Edit files' }] } });
  let round = user;
  const fs = new SnapshotRecordingFilesystemPort(new LocalFilesystemAdapter(), new SnapshotRecorder({
    sessionKind: 'coder', sessionId: session.id, projectId: 7, projectRoot: project, store,
    getTurn: () => round, getRoundMessageId: () => round,
  }));
  const registry = new ToolRegistry();
  registry.register({ name: 'edit_file', source: 'native', description: 'Exercise real recording port',
    parameters: { type: 'object', properties: {} }, handler: async args => {
      const file = join(project, String(args.path));
      if (args.remove) await fs.unlink(file);
      else if (args.rename) await fs.rename(file, join(project, String(args.rename)));
      else for (const content of args.contents as string[]) await fs.writeFile(file, content);
      return { content: 'edited' };
    } });
  return { project, session, fs, get store() { return store; },
    invoke: (id: string, path: string, contents: string[], extra = {}) => registry.invoke('edit_file', { path, contents, ...extra },
      { cwd: project, projectName: 'test', currentToolUseId: id }),
    snapshots: (id: string) => store.listToolSnapshots!('coder', session.id, id),
    nextRound: async () => { round = (await store.appendMessage({ session_id: session.id,
      message: { role: 'user', content: [{ type: 'text', text: 'Edit again' }] } })); },
    restart: async () => { await store.close(); store = open(); },
  };
}

it('freezes each invocation across later edits, rounds, disk changes and restart while retaining cumulative summaries', async () => {
  const f = await fixture();
  await writeFile(join(f.project, 'a.ts'), 'original\n');
  expect(await f.invoke('first', 'a.ts', ['first\nextra\n'])).not.toHaveProperty('isError');
  expect(await f.invoke('second', 'a.ts', ['first\nsecond\nextra\n'])).not.toHaveProperty('isError');
  const first = (await f.snapshots('first'))[0]!;
  expect(toolSnapshotSummary(first, 0)).toMatchObject({ addedLines: 2, removedLines: 1 });
  expect(toolSnapshotSummary((await f.snapshots('second'))[0]!, 0)).toMatchObject({ addedLines: 1, removedLines: 0 });
  const service = new SessionSnapshotService(f.store, () => f.project);
  expect(await service.listRoundFiles('coder', f.session.id, first.round_message_id!)).toMatchObject([{ addedLines: 3, removedLines: 1 }]);
  expect(await service.listFiles('coder', f.session.id)).toMatchObject([{ addedLines: 3, removedLines: 1 }]);
  await f.nextRound();
  await f.invoke('third', 'a.ts', ['final\n']);
  await writeFile(join(f.project, 'a.ts'), 'external edit\n');
  await f.restart();
  await f.nextRound(); // Acquires a writer and runs artifact recovery after reopening.
  expect(await f.snapshots('first')).toEqual([first]);
  const diff = toolSnapshotDiff(first, { context: 0 });
  expect(diff.hunks[0]!.lines).toEqual([
    { type: 'add', content: 'first', newLine: 1 },
    { type: 'add', content: 'extra', newLine: 2 },
    { type: 'remove', content: 'original', oldLine: 1 },
  ]);
  expect(diff.currentContent).toBe('first\nextra\n');
  expect(await f.snapshots('legacy-no-capture')).toEqual([]);
});

it('keeps concurrent identities separate, merges writes within one call and records rename/delete only after success', async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.invoke('a', 'a.ts', ['intermediate\n', 'final a\n']),
    f.invoke('b', 'b.ts', ['final b\n']),
  ]);
  expect(results.every(r => !r.isError)).toBe(true);
  const a = await f.snapshots('a'), b = await f.snapshots('b');
  expect(a).toMatchObject([{ file_path: 'a.ts', content_before: null, content_after: 'final a\n', existed_before: false }]);
  expect(b).toMatchObject([{ file_path: 'b.ts', content_after: 'final b\n' }]);
  await f.invoke('rename', 'a.ts', [], { rename: 'moved.ts' });
  expect(await f.snapshots('rename')).toMatchObject([
    { file_path: 'a.ts', existed_after: false, content_after: null },
    { file_path: 'moved.ts', existed_before: false, content_after: 'final a\n' },
  ]);
  await f.invoke('delete', 'moved.ts', [], { remove: true });
  expect(await f.snapshots('delete')).toMatchObject([{ content_before: 'final a\n', existed_after: false }]);
  expect(await f.invoke('failed', 'missing/dir.ts', ['fail'])).toHaveProperty('isError', true);
  expect(await f.snapshots('failed')).toEqual([]);
  expect(await f.snapshots('a')).toEqual(a);
});
