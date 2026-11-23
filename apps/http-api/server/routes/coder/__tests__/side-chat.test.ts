import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatProvider, ChatRequest } from '@mcp/provider-sdk';
import { asSessionId, type SessionLocation } from '@mcp/session-storage';
import type { FsCoderSession } from '@mcp/session-storage/fs-store/index.js';
import { readSideChatFile, writeSideChatFile } from '@mcp/session-storage/side-chat-file.js';
import type { SideChatTarget, SideChatView } from '@mcp/shared/side-chat.js';
import { SideChatService } from '../side-chat-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const target: SideChatTarget = { provider: 'openai-chatgpt', model: 'gpt-6.2-sol', effort: 'max', thinking: true, contextWindow: 200000 };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'side-service-'));
  roots.push(root);
  const parent = asSessionId(randomUUID());
  const location: SessionLocation = { session_id: parent, session_root: root, scope: { kind: 'global' }, bundle_path: join(root, parent) };
  await mkdir(location.bundle_path);
  const journal = join(location.bundle_path, 'conversation.jsonl');
  await writeFile(journal, 'parent journal');
  const state = { revision: 'first', text: 'visible first', selectedText: 'old message', throughSeq: 12, truncated: false };
  const sessions = { getSession: vi.fn(async () => ({ ...target } as unknown as FsCoderSession)),
    getSessionLocation: vi.fn(async (): Promise<SessionLocation | null> => location),
    readSideChatContext: vi.fn(async () => ({ ...state })) };
  const calls: ChatRequest[] = [];
  const adapter: ChatProvider = { name: target.provider, model: target.model, setModel() {}, inferenceOnly: true,
    async *chat(req) {
      calls.push(req);
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'done', stop_reason: 'end_turn' };
    } };
  const providerFor = vi.fn(async (_target: SideChatTarget) => adapter);
  const service = () => new SideChatService(sessions, (_session, choice) =>
    choice ? { ...target, ...choice, contextWindow: 1024 } : target, providerFor, () => 'in progress text');
  const side = service();
  async function finished(id: string) {
    let offset = 0;
    for (;;) {
      const part = await side.progress(parent, id, offset, AbortSignal.timeout(3000));
      if (part.status !== 'running') return part;
      offset += part.answer.length;
    }
  }
  return { parent, location, journal, state, sessions, calls, adapter, providerFor, service, side, finished };
}

describe('side conversation', () => {
  it('streams reasoning status and public text before completion and resumes the same request at its character offset', async () => {
    const f = await setup();
    const textGate = gate(), endGate = gate();
    const prefix = 'Já 🚀';
    f.adapter.chat = async function* () {
      yield { type: 'thinking_delta', text: 'private scratchpad' };
      await textGate.promise;
      yield { type: 'text_delta', text: prefix };
      await endGate.promise;
      yield { type: 'text_delta', text: ' chegou' };
      yield { type: 'done', stop_reason: 'end_turn' };
    };
    const id = randomUUID();
    const first = new AbortController();
    await f.side.submit(f.parent, id, 'when?');
    try {
      const feed = await f.side.stream(f.parent, id, 0, first.signal);
      const thinking = (await feed.next()).value;
      expect(thinking).toMatchObject({ status: 'running', reasoning: true, offset: 0, answer: '' });
      expect(JSON.stringify(thinking)).not.toContain('private scratchpad');
      textGate.resolve();
      expect((await feed.next()).value).toMatchObject({ status: 'running', offset: 0, answer: prefix });
      first.abort();
      expect((await feed.next()).done).toBe(true);
      await expect(f.side.setTarget(f.parent, { provider: 'different', model: 'small', effort: null })).rejects.toThrow(/current side answer/);
      const resumed = await f.side.stream(f.parent, id, prefix.length, AbortSignal.timeout(3000));
      expect((await resumed.next()).value).toMatchObject({ status: 'running', offset: prefix.length, answer: '' });
      endGate.resolve();
      let suffix = '';
      let status;
      for await (const part of resumed) {
        if (part) { suffix += part.answer; status = part.status; }
      }
      expect(suffix).toBe(' chegou');
      expect(status).toBe('completed');
      const replay = await f.service().stream(f.parent, id, 999, AbortSignal.timeout(3000));
      expect((await replay.next()).value).toMatchObject({ status: 'completed', offset: 0, answer: prefix + suffix });
      expect(f.providerFor).toHaveBeenCalledTimes(1);
    } finally { textGate.resolve(); endGate.resolve(); }
  });

  it('persists the side model, applies it only to new requests, and fits the frozen reference to a smaller model', async () => {
    const f = await setup();
    f.state.text = 'old marker' + ' '.repeat(1000) + 'recent marker';
    const first = randomUUID(), second = randomUUID();
    await f.side.submit(f.parent, first, 'first');
    await f.finished(first);
    const choice = { provider: 'other', model: 'small::fast', effort: 'low' };
    await f.side.setTarget(f.parent, choice);
    f.state.text = 'new unsaved reference';
    await f.side.submit(f.parent, second, 'second');
    await f.finished(second);
    const reopened = await f.service().open(f.parent);
    expect(reopened.target).toMatchObject(choice);
    expect(reopened.turns[0]?.target).toMatchObject(target);
    expect(reopened.turns[1]).toMatchObject({ target: choice, context: { revision: 'first', truncated: true } });
    expect(f.providerFor.mock.calls.map(([selected]) => selected.model)).toEqual([target.model, choice.model]);
    expect(f.calls.map(req => req.reasoningEffort)).toEqual(['max', 'low']);
    const input = JSON.stringify(f.calls[1]?.messages);
    expect(input).toContain('recent marker');
    expect(input).not.toMatch(/old marker|new unsaved reference/);
    expect(await readFile(f.journal, 'utf8')).toBe('parent journal');
  });

  it('freezes a journal revision including same-sequence replacements, replays only its own turns and refreshes explicitly', async () => {
    const f = await setup();
    const chat = await f.side.open(f.parent);
    expect(f.calls).toHaveLength(0);
    Object.assign(f.state, { revision: 'second', text: 'replacement after compaction' });
    await f.side.update(f.parent, 'select', { seq: 1, text: 'old message' });
    const first = randomUUID(), second = randomUUID();
    await Promise.all([f.side.submit(f.parent, first, 'one'), f.side.submit(f.parent, first, 'one')]);
    await f.finished(first);
    await f.side.submit(f.parent, second, 'two');
    await f.finished(second);
    expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(f.calls[1]!.messages)).toContain('visible first');
    expect(JSON.stringify(f.calls[1]!.messages)).toContain('old message');
    expect(JSON.stringify(f.calls[1]!.messages)).not.toContain('replacement after compaction');
    expect(f.calls[1]).toMatchObject({ sessionId: chat.id, tools: [], reasoningEffort: 'max', thinking: true });
    expect(chat.id).not.toBe(f.parent);
    await f.side.update(f.parent, 'refresh');
    const third = randomUUID();
    await f.side.submit(f.parent, third, 'three');
    await f.finished(third);
    expect(JSON.stringify(f.calls[2]!.messages)).toContain('replacement after compaction');
    const reopened = await f.service().open(f.parent);
    expect(reopened.turns.map(t => t.context.revision)).toEqual(['first','first','second']);
    await expect(f.side.submit(f.parent, first, 'different')).rejects.toThrow();
    expect(await readFile(f.journal, 'utf8')).toBe('parent journal');
  });

  it('rejects nonpublic selections, validates streamed text and blocks side access after the parent is trashed', async () => {
    const f = await setup();
    await expect(f.side.update(f.parent, 'select', { seq: null, text: 'hidden reasoning' })).rejects.toThrow();
    expect((await f.side.update(f.parent, 'select', { seq: null, text: 'progress text' })).selection?.seq).toBeNull();
    f.sessions.getSessionLocation.mockResolvedValue(null);
    await expect(f.side.open(f.parent)).rejects.toThrow();
    await expect(f.side.submit(f.parent, randomUUID(), 'inaccessible')).rejects.toThrow();
    f.sessions.getSessionLocation.mockResolvedValue(f.location);
    expect((await f.side.open(f.parent)).selection?.text).toBe('progress text');
    await f.side.clear(f.parent);
    expect(await readSideChatFile(f.location)).toBeNull();
  });

  it('cancels only the active side request, rejects overlapping turns and recovers from provider failure', async () => {
    const f = await setup();
    f.adapter.chat = async function* (req) {
      yield { type: 'text_delta', text: 'partial' };
      await new Promise<void>(resolve => req.signal!.addEventListener('abort', () => resolve(), { once: true }));
    };
    const id = randomUUID();
    await f.side.submit(f.parent, id, 'wait');
    expect((await f.side.progress(f.parent, id, 0, AbortSignal.timeout(3000))).answer).toBe('partial');
    await expect(f.side.submit(f.parent, randomUUID(), 'concurrent')).rejects.toThrow();
    f.side.cancel(f.parent, id);
    expect((await f.finished(id)).status).toBe('cancelled');
    f.adapter.chat = async function* () { throw Error('provider quota'); };
    const failed = randomUUID();
    await f.side.submit(f.parent, failed, 'fail');
    expect(await f.finished(failed)).toMatchObject({ status: 'failed', error: 'provider quota' });
    Object.assign(f.adapter, { inferenceOnly: false });
    const unsafe = randomUUID();
    await f.side.submit(f.parent, unsafe, 'block hosted tools');
    expect((await f.finished(unsafe)).error).toContain('text-only');
    expect(await readFile(f.journal, 'utf8')).toBe('parent journal');
  });

  it('repairs a persisted interrupted turn on restart without sending or duplicating it', async () => {
    const f = await setup();
    const chat = await f.side.open(f.parent);
    const record = (await readSideChatFile<SideChatView & { references: Record<string,string> }>(f.location))!;
    const id = randomUUID();
    record.turns.push({ id, context: chat.context, status: 'running', question: 'pending', answer: '' });
    await writeSideChatFile(f.location, record);
    const reopened = await f.service().submit(f.parent, id, 'pending');
    expect(reopened.turns.map(t => t.status)).toEqual(['interrupted']);
    expect(f.calls).toHaveLength(0);
  });
});
