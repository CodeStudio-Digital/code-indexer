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
  const service = () => new SideChatService(sessions, () => target, async () => adapter, () => 'in progress text');
  const side = service();
  async function finished(id: string) {
    let offset = 0;
    for (;;) {
      const part = await side.progress(parent, id, offset, AbortSignal.timeout(3000));
      if (part.status !== 'running') return part;
      offset += part.answer.length;
    }
  }
  return { parent, location, journal, state, sessions, calls, adapter, service, side, finished };
}

describe('side conversation', () => {
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
