import { join } from 'node:path';
import type { ChatCompletion } from './network-types.js';
import type { WorkWaitResult } from '@mcp/agent-runtime-contracts';
import { CollaborationRevisions } from './revisions.js';
import { CollaborationMessageIndex } from './message-index.js';
import { registerWait } from './wait-graph.js';
import { CollaborationFiles, keyOf } from './files.js';
import { rootChatId, type ChatMessage, type ChatMessageStatus, type ChatParticipant, type SendChatMessage } from './types.js';
export * from './types.js';

interface Link { sessions: string[]; enabled: boolean }
export interface ChatDirectory {
  self: ChatParticipant;
  participants: ChatParticipant[];
  peers: ChatParticipant[];
  links: Link[];
}
interface Receipt { id: string; status: ChatMessageStatus; at: number }

/** Cross-worker mailbox; separate from each conversation's exclusive writer. */
export class ChatCollaborationStore {
  readonly files: CollaborationFiles;
  constructor(dataDir: string) { this.files = new CollaborationFiles(join(dataDir, 'chat-collaboration')); }
  init(): Promise<void> { return this.files.init(); }
  async epoch(sessionId: string): Promise<number> {
    return (await new CollaborationRevisions(this.files).read<{ epoch: number }>('epochs', sessionId))?.value.epoch ?? 0;
  }
  async currentGeneration(message: ChatMessage): Promise<boolean> {
    const [from, to] = await Promise.all([this.requireParticipant(message.from), this.requireParticipant(message.to)]);
    return (message.sourceEpoch ?? 0) === await this.epoch(from.sessionId)
      && (message.targetEpoch ?? 0) === await this.epoch(to.sessionId);
  }
  async recordCompletion(completion: ChatCompletion): Promise<void> {
    await this.files.insert('completion-events', `${completion.sessionId}:${completion.runId}`, completion);
    const initial = await this.completionOrder(completion.sessionId);
    await new CollaborationRevisions(this.files).change<string[]>('completion-order', completion.sessionId, initial,
      ids => ids.includes(completion.runId) ? ids : [...ids, completion.runId]);
    // Compatibility projection only; dependency delivery consumes immutable events.
    await this.files.put('completions', completion.sessionId, completion);
  }
  async completions(sessionId: string): Promise<ChatCompletion[]> {
    const ids = await this.completionOrder(sessionId);
    return Promise.all(ids.map(async id => {
      const row = await this.files.get<ChatCompletion>('completion-events', `${sessionId}:${id}`);
      if (!row) throw new Error('corrupt_completion_journal: indexed event is missing');
      return row;
    }));
  }
  private async completionOrder(sessionId: string): Promise<string[]> {
    const revisions = new CollaborationRevisions(this.files);
    const existing = await revisions.read<string[]>('completion-order', sessionId);
    if (existing) {
      // A previous binary can still publish the legacy projection. Import a
      // newly observed run once without re-sorting the committed journal.
      const legacy = await this.files.get<ChatCompletion>('completions', sessionId);
      if (!legacy || existing.value.includes(legacy.runId)) return existing.value;
      await this.files.insert('completion-events', `${sessionId}:${legacy.runId}`, legacy);
      return (await revisions.change('completion-order', sessionId, existing.value,
        ids => ids.includes(legacy.runId) ? ids : [...ids, legacy.runId])).value;
    }
    // One-time legacy import. After publication, cursors follow commit order,
    // never the wall clock (which may move backward after sleep/NTP).
    const events = (await this.files.list<ChatCompletion>('completion-events')).filter(row => row.sessionId === sessionId);
    const legacy = await this.files.get<ChatCompletion>('completions', sessionId);
    if (legacy && !events.some(row => row.runId === legacy.runId)) events.push(legacy);
    if (legacy) await this.files.insert('completion-events', `${sessionId}:${legacy.runId}`, legacy);
    const ids = events.sort((a, b) => a.at - b.at || a.runId.localeCompare(b.runId)).map(row => row.runId);
    return (await revisions.change('completion-order', sessionId, ids, current => current)).value;
  }
  subscribe(listener: () => void): () => void { return this.files.subscribe(listener); }
  async register(input: Omit<ChatParticipant, 'updatedAt'>): Promise<ChatParticipant> {
    const participant = { ...input, updatedAt: Date.now() };
    await this.files.put('participants', input.id, participant);
    return participant;
  }
  participant(id: string): Promise<ChatParticipant | null> { return this.files.get('participants', id); }
  async linkSessions(left: string, right: string, enabled: boolean): Promise<void> {
    if (left === right) throw new Error('A chat cannot link itself');
    const sessions = [left, right].sort();
    await this.files.put('links', sessions.join('\n'), { sessions, enabled } satisfies Link);
  }
  async connected(left: string, right: string): Promise<boolean> {
    return left === right || (await this.files.get<Link>('links', [left, right].sort().join('\n')))?.enabled === true;
  }
  async peers(actor: string): Promise<ChatParticipant[]> {
    return (await this.directory(actor)).peers;
  }
  /** One request-local view of membership. Writes still check the exact link
   * with connected() at delivery time. */
  async directory(actor: string): Promise<ChatDirectory> {
    const [participants, links] = await Promise.all([
      this.files.list<ChatParticipant>('participants'),
      this.files.list<Link>('links'),
    ]);
    const self = participants.find(p => p.id === actor);
    if (!self) throw new Error(`Unknown chat '${actor}'. Use list_chats to discover connected chats.`);
    const sessions = new Set([self.sessionId]);
    for (const link of links) {
      if (link.enabled !== true || !Array.isArray(link.sessions) || link.sessions.length !== 2) continue;
      const [left, right] = link.sessions;
      if (left === self.sessionId) sessions.add(right);
      if (right === self.sessionId) sessions.add(left);
    }
    const peers = participants.filter(p => p.id !== actor && sessions.has(p.sessionId))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { self, participants, peers, links };
  }
  async requireParticipant(id: string): Promise<ChatParticipant> {
    const peer = await this.participant(id);
    if (!peer) throw new Error(`Unknown chat '${id}'. Use list_chats to discover connected chats.`);
    return peer;
  }
  /**
   * `fromStopped`: the app's own end notice of a stopped chat (a child agent
   * whose chat the user stopped) may leave it; agents of a stopped chat never send.
   */
  async send(input: SendChatMessage, options: { fromStopped?: boolean } = {}): Promise<ChatMessage> {
    const from = await this.requireParticipant(input.from);
    const to = await this.requireParticipant(input.to);
    if ((from.state === 'stopped' && !options.fromStopped) || to.state === 'stopped') throw new Error('target_generation_changed: stopped participants cannot receive new work');
    if (from.id === to.id) throw new Error('Cannot message yourself');
    if (!await this.connected(from.sessionId, to.sessionId)) throw new Error('Chats are not linked to collaborate');
    if (!input.idempotencyKey || !input.body.trim() || input.body.length > 32_000) throw new Error('A message needs an idempotency key and 1–32000 characters');
    if (!['notify', 'question', 'task', 'response'].includes(input.kind)) throw new Error('Invalid message kind');
    const id = keyOf(`${input.from}\n${input.idempotencyKey}`);
    const existing = await this.files.get<ChatMessage>('messages', id);
    const references = (input.references ?? []).slice(0, 20);
    if (references.some(ref => typeof ref !== 'string' || ref.length > 2000)) throw new Error('Invalid artifact reference');
    if (existing) {
      if (existing.to !== input.to || existing.kind !== input.kind || existing.body !== input.body || existing.replyTo !== input.replyTo || JSON.stringify(existing.references) !== JSON.stringify(references)) throw new Error('Idempotency key already belongs to a different message');
      return this.get(id);
    }
    if (input.kind === 'response') {
      if (!input.replyTo) throw new Error('A response needs replyTo');
      const request = await this.get(input.replyTo);
      if (request.to !== input.from || request.from !== input.to || !['question', 'task'].includes(request.kind)) throw new Error('Response does not match its request');
      if (['cancelled', 'expired'].includes(request.status)) throw new Error('Request is no longer active');
    }
    const recent = (await this.messages(input.from)).filter(row => row.from === input.from && row.createdAt > Date.now() - 60_000);
    if (recent.length >= 40) throw new Error('Collaboration message budget reached; continue useful work instead of pinging peers');
    const createdAt = Date.now();
    const message: ChatMessage = { schemaVersion: 2, origin: 'agent', correlationId: input.replyTo ?? id,
      sourceEpoch: await this.epoch(from.sessionId), targetEpoch: await this.epoch(to.sessionId),
      id, from: input.from, to: input.to, kind: input.kind, body: input.body,
      references, ...(input.replyTo ? { replyTo: input.replyTo } : {}), createdAt,
      deadlineAt: createdAt + Math.min(86_400_000, Math.max(1000, input.timeoutMs ?? 3_600_000)), status: 'queued' };
    await new CollaborationMessageIndex(this.files).prepare(message);
    const published = await this.files.insert('messages', id, message);
    if (published.body !== message.body || published.to !== message.to || published.kind !== message.kind
      || published.replyTo !== message.replyTo || JSON.stringify(published.references) !== JSON.stringify(message.references)) throw new Error('Concurrent idempotency conflict');
    return published;
  }
  async get(id: string): Promise<ChatMessage> {
    const message = await this.files.get<ChatMessage>('messages', id);
    if (!message) throw new Error('Message not found');
    return this.project(message);
  }
  async messages(actor?: string, limit = 100): Promise<ChatMessage[]> {
    const all = actor ? await new CollaborationMessageIndex(this.files).read('participant', actor) : await this.files.list<ChatMessage>('messages');
    const responses = new Set(all.filter(row => row.kind === 'response').map(row => row.replyTo));
    const rows = all.filter(row => !actor || row.from === actor || row.to === actor);
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return Promise.all(rows.slice(0, Math.min(500, Math.max(1, limit))).map(row => this.project(row, responses)));
  }
  async pending(actor?: string, options: { wakeOnly?: boolean } = {}): Promise<ChatMessage[]> {
    const all = actor ? await new CollaborationMessageIndex(this.files).read('participant', actor) : await this.files.list<ChatMessage>('messages');
    const responses = new Set(all.filter(row => row.kind === 'response').map(row => row.replyTo));
    const now = Date.now();
    const candidates = all.filter(row => (!actor || row.to === actor || row.from === actor) && row.deadlineAt > now
      && (!options.wakeOnly || row.kind !== 'notify')
      && (!['question', 'task'].includes(row.kind) || !responses.has(row.id)));
    const rows: ChatMessage[] = [];
    // Recovery visits the full history, including old work behind recent notifications.
    // Do not open two receipt files per notification or flood the filesystem queue
    // with an unbounded Promise.all when many chats have pending work.
    for (let offset = 0; offset < candidates.length; offset += 32) {
      rows.push(...await Promise.all(candidates.slice(offset, offset + 32).map(row => this.project(row, responses))));
    }
    return rows.filter(row => row.status === 'queued' || (!options.wakeOnly && row.status === 'delivered'))
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async responses(requestId: string): Promise<ChatMessage[]> {
    return (await new CollaborationMessageIndex(this.files).read('response', requestId)).filter(row => row.kind === 'response');
  }
  async project(message: ChatMessage, responses?: Set<string | undefined>): Promise<ChatMessage> {
    const receipt = await this.files.get<Receipt>('receipts', `${message.id}:cancelled`);
    if (receipt) return { ...message, status: 'cancelled' };
    if (message.kind === 'question' || message.kind === 'task') {
      if (responses ? responses.has(message.id) : (await this.responses(message.id)).length > 0) return { ...message, status: 'answered' };
    }
    if (Date.now() > message.deadlineAt) return { ...message, status: 'expired' };
    const delivered = await this.files.get<Receipt>('receipts', `${message.id}:delivered`);
    return { ...message, status: delivered ? 'delivered' : 'queued' };
  }
  async acknowledge(actor: string, id: string): Promise<void> {
    const message = await this.get(id);
    if (message.to !== actor) throw new Error('Only the recipient can acknowledge a message');
    await this.files.insert('receipts', `${id}:delivered`, { id, status: 'delivered', at: Date.now() } satisfies Receipt);
  }
  async cancel(actor: string, id: string): Promise<void> {
    const message = await this.get(id);
    if (message.from !== actor) throw new Error('Only the sender can cancel a request');
    if (message.status === 'answered') return;
    await this.files.insert('receipts', `${id}:cancelled`, { id, status: 'cancelled', at: Date.now() } satisfies Receipt);
  }
  async wait(actor: string, requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<ChatMessage[]> {
    const result = await this.waitResult(actor, requestId, timeoutMs, signal);
    if (result.reason === 'cycle_detected') throw new Error('Circular wait: continue independent work or answer the pending peer request first');
    return result.items;
  }
  async waitResult(actor: string, requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<WorkWaitResult<ChatMessage>> {
    const request = await this.get(requestId);
    if (request.from !== actor) throw new Error('Only the sender can wait for this response');
    const until = Date.now() + Math.min(60_000, Math.max(0, timeoutMs));
    const edge = await registerWait(this.files, actor, [request.to], 'all', until);
    let stop = () => {};
    try {
      return await new Promise((resolve, reject) => {
        let checking = false;
        let dirty = false;
        let finished = false;
        const finish = (reason: WorkWaitResult<ChatMessage>['reason'], rows: ChatMessage[] = []) => {
          if (!finished) { finished = true; stop(); resolve({ schemaVersion: 1, reason, items: rows, cursor: rows.at(-1)?.id ?? null }); }
        };
        const check = async () => {
          if (finished) return;
          if (checking) { dirty = true; return; }
          dirty = false;
          checking = true;
          try {
            const rows = await this.responses(requestId);
            if (rows.length) finish('response', rows);
            else {
              if (await edge.cyclic()) { finish('cycle_detected'); return; }
              const status = (await this.get(requestId)).status;
              if (status === 'expired' || status === 'cancelled') finish(status);
            }
          } catch (error) { finished = true; stop(); reject(error); }
          finally { checking = false; if (dirty && !finished) void check(); }
        };
        const unsubscribe = this.subscribe(() => { void check(); });
        const timer = setTimeout(() => finish('timeout'), Math.max(0, until - Date.now()));
        const abort = () => finish('aborted');
        stop = () => { unsubscribe(); clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else void check();
      });
    } finally { stop(); await edge.dispose(); }
  }
  async stopSession(sessionId: string): Promise<void> {
    await new CollaborationRevisions(this.files).change('epochs', sessionId, { epoch: 0 }, state => ({ epoch: state.epoch + 1 }));
    for (const peer of await this.files.list<ChatParticipant>('participants')) {
      if (peer.sessionId === sessionId) await this.register({ ...peer, state: 'stopped' });
    }
    for (const trigger of await this.files.list<import('./network-types.js').ChatTrigger>('triggers')) {
      if (trigger.status === 'waiting' && [trigger.ownerSessionId, trigger.sourceSessionId, trigger.targetSessionId].includes(sessionId)) {
        await this.files.put('triggers', trigger.id, { ...trigger, status: 'cancelled' });
      }
    }
    for (const message of await this.pending()) {
      const source = await this.participant(message.from);
      const target = await this.participant(message.to);
      if ((source?.sessionId === sessionId || target?.sessionId === sessionId) && ['question', 'task'].includes(message.kind)) await this.cancel(message.from, message.id);
    }
  }
  async registerRoot(sessionId: string, label: string, state: ChatParticipant['state'] = 'idle'): Promise<ChatParticipant> {
    return this.register({ id: rootChatId(sessionId), sessionId, label, profile: 'coordinator', state });
  }
}
