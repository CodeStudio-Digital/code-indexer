import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FsSessionStore } from '../fs-store/fs-session-store.js';
import { readSideChatFile, writeSideChatFile } from '../side-chat-file.js';

it('captures only public completed evidence and follows the parent through trash, restore and purge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'side-context-'));
  const store = FsSessionStore.fromRoots({ dataDir: join(root, 'data'),
    projectRootResolver: { resolveProjectRoot: () => root, listProjectRoots: () => [{ project_id: 7, root_path: root }] } });
  try {
    const parent = await store.createSession({ project_id: 7, title: 'parent', provider: 'p', model: 'm' });
    const location = (await store.getSessionLocation(parent.id))!;
    const seq = await store.appendMessage({ session_id: parent.id, message: { role: 'user', content: [{ type: 'text', text: 'visible' }] } });
    await store.appendMessage({ session_id: parent.id, message: { role: 'user', isMeta: true, content: [{ type: 'text', text: 'internal' }] } });
    await store.appendMessage({ session_id: parent.id, message: { role: 'assistant', content: [
      { type: 'thinking', text: 'private reasoning' }, { type: 'tool_use', id: 'tool', name: 'read', input: { path: 'sample.txt' } },
    ] } });
    const before = await store.readSideChatContext(parent.id, 2048);
    expect(before.text).toContain('visible');
    expect(before.text).not.toMatch(/sample\.txt|internal|private/);
    await store.appendMessage({ session_id: parent.id, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool', content: 'public result' },
    ] } });
    const after = await store.readSideChatContext(parent.id, 2048, seq);
    expect(after.revision).not.toBe(before.revision);
    expect(after.text).toContain('sample.txt');
    expect(after.text).toContain('public result');
    expect(after.text).not.toMatch(/internal|private/);
    expect(after.selectedText).toBe('visible');
    await writeSideChatFile(location, { saved: true });
    const [first] = await store.trashSessionsBatch([parent.id]);
    expect(await store.getSessionLocation(parent.id)).toBeNull();
    await store.restoreTrashedSession(location.scope, first!.trash_name);
    expect(await readSideChatFile(location)).toEqual({ saved: true });
    const [next] = await store.trashSessionsBatch([parent.id]);
    await store.purgeTrashedSession(location.scope, next!.trash_name);
    expect(await readSideChatFile(location)).toBeNull();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
