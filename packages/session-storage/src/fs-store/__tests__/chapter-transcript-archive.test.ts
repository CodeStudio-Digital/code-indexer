import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson, FileSessionRepository, SessionLocator, type SessionId, type SessionStorageFaultInjector } from '../../index.js';
import { ChapterArchiveReader, materializeChapterMessage } from '../../chapter-transcript.js';
import { projectConversation } from '../conversation-codec.js';
import { ChapterRecordReader } from '../../chapter-records.js';
import type { AgentMessage } from '@mcp/provider-sdk';
import { FsSessionStore } from '../fs-session-store.js';

let root: string;
let locator: SessionLocator;
let store: FsSessionStore;
let id: SessionId;
let bundle: string;
let inject: SessionStorageFaultInjector | undefined;
const open = () => new FsSessionStore({ locator, repository: new FileSessionRepository({
  locator, faultInjector: ctx => inject?.(ctx),
}) });
const append = (operation_id: string, message: AgentMessage) => store.appendMessage({ session_id: id, operation_id, message });
const user = (text: string) => append(randomUUID(), { role: 'user', content: [{ type: 'text', text }] });
const checkpoint = (start: number, end: number, boundary = 0) => store.commitConversationChapter({
  sessionId: id, expectedBoundarySeq: boundary, startMessageSeq: start, endMessageSeq: end,
  source: 'auto', trigger: 'context_threshold', chapterKind: 'context', title: 'Checkpoint',
  chapterJson: '{}', chapterText: 'Summary', resumeJson: '{}', resumeText: 'Continue', version: 3,
});
const journal = () => readFile(join(bundle, 'conversation.jsonl'), 'utf8');
const restart = async () => { await store.close(); store = open(); };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chapter-source-'));
  const project = join(root, 'project');
  await mkdir(project);
  locator = new SessionLocator({ dataDir: join(root, 'profile'), projectRootResolver: {
    resolveProjectRoot: () => project, listProjectRoots: () => [{ project_id: 1, root_path: project }],
  } });
  inject = undefined;
  store = open();
  id = (await store.createSession({ project_id: 1, provider: 'test', model: 'test', title: 'Archive' })).id;
  bundle = (await store.getSessionLocation(id))!.bundle_path;
});
afterEach(async () => { vi.restoreAllMocks(); await store.close(); await rm(root, { recursive: true, force: true }); });

it('opens only the requested original, preserves replay across patches, and skips archived bodies on resume', async () => {
  const original: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'First draft with ünicode' }],
    providerReplay: { format: 'openai-responses-v1', scope: 'scope', messageDigest: 'digest',
      items: [{ type: 'reasoning', encrypted_content: 'opaque-original' }] } };
  await append('assistant-draft', original);
  await user('second archived body');
  await user('active question');
  const before = await store.repository.readConversation((await store.getSessionLocation(id))!);
  const c1 = await checkpoint(1, 1);
  const c2 = await checkpoint(2, 2, 1);
  if (c1.status !== 'committed' || c2.status !== 'committed') throw new Error('Expected two chapters');
  const packed = await journal();
  expect(packed).not.toContain('First draft with ünicode');
  expect(packed).not.toContain('opaque-original');
  expect(packed).not.toContain('second archived body');
  expect(packed).toContain('active question');
  expect(await store.repository.readConversation((await store.getSessionLocation(id))!)).toEqual(before);
  await restart();
  const reads = vi.spyOn(ChapterArchiveReader.prototype, 'read');
  const syncRead = vi.spyOn(store.repository, 'readConversationSync');
  const [visible, status] = await Promise.all([store.loadSessionMessagesTail(id, 40), store.getConversationChapterStatus(id)]);
  expect(visible?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'active question' }] }]);
  expect(status).toMatchObject({ boundary_seq: 2, unsummarized_messages: 1 });
  expect(reads).not.toHaveBeenCalled();
  expect(syncRead).not.toHaveBeenCalled();
  const source = await store.listConversationChapterSource(id, c2.chapter.id);
  expect(source.items.map(row => row.seq)).toEqual([2]);
  expect(reads.mock.calls.map(([, ref]) => ref.chapter)).toEqual([c2.chapter.id]);
  await store.persistAssistantTurn({ session_id: id, operation_id: 'amend-draft', existing_message_seq: 1, usage: null, tool_calls: [],
    message: { role: 'assistant', content: [{ type: 'text', text: 'Edited after archival' }] } });
  const edited = { role: 'assistant', content: [{ type: 'text', text: 'Edited after archival' }] };
  const latePatch = JSON.parse((await readFile(join(bundle, 'journal.jsonl'), 'utf8')).trimEnd().split('\n').at(-1)!);
  expect(latePatch.chapter_record.chapter).toBe(c1.chapter.id);
  expect((await store.loadAllSessionMessages(id))?.messages[0]).toEqual(edited);
  await checkpoint(3, 3, 2);
  expect(await journal()).not.toContain('Edited after archival');
  await restart();
  expect((await store.loadAllSessionMessages(id))?.messages[0]).toEqual(edited);
  const second = await store.duplicateSession(id);
  expect((await store.loadAllSessionMessages(second.id))?.messages).toEqual((await store.loadAllSessionMessages(id))?.messages);
  const secondLocation = (await store.getSessionLocation(second.id))!;
  expect(await readFile(join(secondLocation.bundle_path, 'conversation.jsonl'), 'utf8')).toBe(await journal());
});

it.each(['before', 'after'])('recovers a legacy upgrade interrupted %s publishing the ledger', async when => {
  await user('old source');
  await user('only active question');
  await checkpoint(1, 1);
  const location = (await store.getSessionLocation(id))!;
  const original = await store.repository.readConversation(location);
  await store.close();
  await unlink(join(bundle, 'journal.jsonl'));
  const legacy = original.map(r => JSON.stringify(r) + '\n').join('');
  await writeFile(join(bundle, 'conversation.jsonl'), legacy);
  store = open();
  inject = ctx => {
    if (ctx.path?.endsWith('journal.jsonl') && ctx.point === (when === 'before'
      ? 'atomic:after-temp-fsync-before-rename' : 'atomic:after-rename-before-directory-fsync')) {
      inject = undefined;
      throw new Error('interrupted upgrade');
    }
  };
  await expect(store.repository.primeSession(location)).rejects.toThrow('interrupted upgrade');
  expect(await store.repository.readConversation(location)).toEqual(original);
  await restart();
  await store.repository.primeSession(location);
  const text = { role: 'user', content: [{ type: 'text', text: 'only active question' }] };
  expect(JSON.parse(await journal())).toEqual(text);
  await user('next question');
  await store.close();
  await writeFile(join(bundle, 'conversation.jsonl'), '{"interrupted":');
  store = open();
  await store.repository.primeSession(location);
  expect((await journal()).trimEnd().split('\n').map(r => JSON.parse(r).content[0].text)).toEqual(['only active question', 'next question']);
  expect(await store.maxMessageSeq(id)).toBe(3);
});

it('retires a legacy archive with inline replay while an existing chapter reader can still expand its original', async () => {
  await append('draft', { role: 'assistant', content: [{ type: 'text', text: 'archived draft' }],
    providerReplay: { format: 'openai-responses-v1', scope: 'test', messageDigest: 'original',
      items: [{ type: 'reasoning', encrypted_content: 'old opaque value' }] } });
  const chapter = await checkpoint(1, 1);
  if (chapter.status !== 'committed') throw new Error('Expected a committed chapter');
  const location = (await store.getSessionLocation(id))!;
  const original = (await store.repository.readConversation(location))[0]!;
  const legacy = JSON.parse(JSON.stringify(original));
  const row = legacy.payload.messages[0];
  const body = JSON.stringify(row);
  const file = hash(body + '\n');
  const oldPath = join(bundle, 'chapters', chapter.chapter.id, 'messages-' + file + '.ndjson');
  legacy.chapter_sources = [{ collection: 'messages', index: 0, chapter: chapter.chapter.id, file,
    offset: 0, length: Buffer.byteLength(body), sha256: hash(body) }];
  legacy.payload.messages[0] = { ...row, content: [{ type: 'text' }], provider_replay: {} };
  legacy.storage_hash = hash(canonicalJson(legacy));
  await store.close();
  await writeFile(oldPath, body + '\n');
  await unlink(join(bundle, 'journal.jsonl'));
  await writeFile(join(bundle, 'conversation.jsonl'), JSON.stringify(legacy) + '\n');
  store = open();
  const oldView = projectConversation(await store.repository.readConversation(location, 'metadata')).storedMessages[0]!;
  const before = canonicalJson(materializeChapterMessage(oldView));
  await store.repository.primeSession(location);
  await expect(readFile(oldPath)).rejects.toMatchObject({code: 'ENOENT'});
  expect(canonicalJson(materializeChapterMessage(oldView))).toBe(before);
  expect(canonicalJson((await store.repository.readConversation(location))[0])).toBe(canonicalJson(original));
  expect(await journal()).toBe('');
});

it.each([
  ['archive', 'atomic:after-temp-fsync-before-rename'],
  ['journal', 'atomic:after-temp-fsync-before-rename'],
  ['journal', 'atomic:after-rename-before-directory-fsync'],
])('recovers and replays after interrupting %s at %s', async (target, point) => {
  const original = { role: 'user' as const, content: [{ type: 'text' as const, text: 'source before interruption' }] };
  await append('u1', original);
  const initial = await store.repository.readConversation((await store.getSessionLocation(id))!);
  inject = ctx => {
    if (ctx.point === point && (target === 'journal' ? ctx.path?.endsWith('journal.jsonl') : ctx.path?.endsWith('.ndjson'))) {
      inject = undefined;
      throw new Error('simulated power loss');
    }
  };
  await expect(checkpoint(1, 1)).rejects.toThrow('simulated power loss');
  await restart();
  const location = (await store.getSessionLocation(id))!;
  expect(await store.repository.readConversation(location)).toEqual(initial);
  expect((await store.loadAllSessionMessages(id))?.messages).toEqual([original]);
  expect((await store.loadSessionWithMessages(id))?.messages).toEqual([]);
  const replay = await checkpoint(1, 1);
  expect(replay.status).toBe('noop');
  expect(await journal()).not.toContain('source before interruption');
  expect(await append('u1', original)).toBe(1);
  expect(await user('new input')).toBe(2);
  expect((await store.loadAllSessionMessages(id))?.message_rows.map(row => row.seq)).toEqual([1, 2]);
});

it('archives the two halves of a tool turn independently and keeps uncertain results across restart', async () => {
  const toolUseId = 'fixture-action';
  const args = { path: 'fixture.txt' };
  await store.persistAssistantTurn({ session_id: id, operation_id: 'tool-turn', usage: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'write_file', input: args }] },
    tool_calls: [{ tool_use_id: toolUseId, tool_name: 'write_file', args, result_text: 'Receipt missing',
      is_error: true, effect_outcome: 'unknown', duration_ms: 2, run_id: 'fixture-run' }] });
  const initial = (await store.loadAllSessionMessages(id))!;
  await checkpoint(1, 1);
  expect((await store.loadSessionWithMessages(id))?.messages).toEqual(initial.messages.slice(1));
  await checkpoint(2, 2, 1);
  await restart();
  const active = (await store.loadSessionWithMessages(id))!;
  expect(active.messages).toEqual([]);
  expect(active.tool_outcome_state).toEqual(initial.tool_outcome_state);
  expect(active.unresolved_tool_outcomes).toEqual([toolUseId]);
  expect((await store.loadAllSessionMessages(id))?.messages).toEqual(initial.messages);
  const resolution = await store.resolveToolOutcome({ sessionId: id, operationId: 'fixture-reviewed', toolUseId,
    expectedOccurrenceIds: active.tool_outcome_state!.pending.map(incident => incident.occurrenceId),
    resolution: { kind: 'user_acknowledged', evidence: { source: 'user_review', summary: 'Reviewed the affected file.' } } });
  expect(resolution.state.pending).toEqual([]);
});

it('counts visible rows after rollback gaps and refuses damaged archive bytes', async () => {
  await user('retained');
  await user('discard');
  await user('discard later');
  await checkpoint(1, 2);
  await store.rollbackSessionToSeq(id, 2);
  const rerun = await user('new turn after rollback');
  expect(rerun).toBe(4);
  const chapter = await checkpoint(1, 4);
  expect(chapter.status).toBe('committed');
  await user('still visible');
  expect(await store.getConversationChapterStatus(id)).toMatchObject({ boundary_seq: 4, unsummarized_messages: 1 });
  const location = (await store.getSessionLocation(id))!;
  const raw = JSON.parse((await readFile(join(bundle, 'journal.jsonl'), 'utf8')).split('\n')[0]!);
  const packed = new ChapterRecordReader().resolve(bundle, raw) as { chapter_sources?: { chapter: string; file: string }[] };
  const source = packed.chapter_sources![0]!;
  const dir = join(bundle, 'chapters', source.chapter);
  const file = join(dir, 'messages-' + source.file + '.ndjson');
  await rename(file, file + '.backup');
  await expect(store.repository.readConversation(location)).rejects.toThrow();
  const bytes = await readFile(file + '.backup');
  bytes[0] ^= 1;
  await writeFile(file, bytes);
  await expect(store.repository.readConversation(location)).rejects.toThrow(/checksum/);
});
