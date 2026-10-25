import { join } from 'node:path';
import { CollaborationFiles, keyOf } from './files.js';
import { rootChatId, type ChatMessage, type ChatMessageStatus, type ChatParticipant, type SendChatMessage } from './types.js';
export * from './types.js';

interface Link { sessions: string[]; enabled: boolean }
interface Receipt { id: string; status: ChatMessageStatus; at: number }
interface Wait { participant: string; target: string; until: number }

/** Cross-worker mailbox; separate from each conversation's exclusive writer. */
export class ChatCollaborationStore {
  readonly files: CollaborationFiles;
  constructor(dataDir: string) { this.files = new CollaborationFiles(join(dataDir, 'chat-collaboration')); }
  init(): Promise<void> { return this.files.init(); }
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
    const self = await this.requireParticipant(actor);
    const peers = await this.files.list<ChatParticipant>('participants');
    const allowed = await Promise.all(peers.map(async peer => peer.id !== actor && await this.connected(self.sessionId, peer.sessionId)));
    return peers.filter((_, index) => allowed[index]).sort((a, b) => a.id.localeCompare(b.id));
  }
  async requireParticipant(id: string): Promise<ChatParticipant> {
    const peer = await this.participant(id);
    if (!peer) throw new Error(`Unknown chat '${id}'. Use list_chats to discover connected chats.`);
    return peer;
  }
  async send(input: SendChatMessage): Promise<ChatMessage> {
    const from = await this.requireParticipant(input.from);
    const to = await this.requireParticipant(input.to);
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
    const message: ChatMessage = { id, from: input.from, to: input.to, kind: input.kind, body: input.body,
      references, ...(input.replyTo ? { replyTo: input.replyTo } : {}), createdAt,
      deadlineAt: createdAt + Math.min(86_400_000, Math.max(1000, input.timeoutMs ?? 3_600_000)), status: 'queued' };
    const published = await this.files.insert('messages', id, message);
    if (published.body !== message.body || published.to !== message.to || published.kind !== message.kind) throw new Error('Concurrent idempotency conflict');
    return published;
  }
  async get(id: string): Promise<ChatMessage> {
    const message = await this.files.get<ChatMessage>('messages', id);
    if (!message) throw new Error('Message not found');
    return this.project(message);
  }
  async messages(actor?: string, limit = 100): Promise<ChatMessage[]> {
    const all = await this.files.list<ChatMessage>('messages');
    const responses = new Set(all.filter(row => row.kind === 'response').map(row => row.replyTo));
    const rows = all.filter(row => !actor || row.from === actor || row.to === actor);
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return Promise.all(rows.slice(0, Math.min(500, Math.max(1, limit))).map(row => this.project(row, responses)));
  }
  async pending(actor?: string): Promise<ChatMessage[]> {
    const all = await this.files.list<ChatMessage>('messages');
    const responses = new Set(all.filter(row => row.kind === 'response').map(row => row.replyTo));
    const candidates = all.filter(row => (!actor || row.to === actor || row.from === actor) && row.deadlineAt > Date.now());
    const rows = await Promise.all(candidates.map(row => this.project(row, responses)));
    return rows.filter(row => row.status === 'queued' || row.status === 'delivered').sort((a, b) => a.createdAt - b.createdAt);
  }
  async responses(requestId: string): Promise<ChatMessage[]> {
    return (await this.files.list<ChatMessage>('messages')).filter(row => row.kind === 'response' && row.replyTo === requestId);
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
    const request = await this.get(requestId);
    if (request.from !== actor) throw new Error('Only the sender can wait for this response');
    const until = Date.now() + Math.min(60_000, Math.max(0, timeoutMs));
    await this.files.put('waits', actor, { participant: actor, target: request.to, until } satisfies Wait);
    let stop = () => {};
    try {
      const waits = (await this.files.list<Wait>('waits')).filter(row => row.until > Date.now());
      const seen = new Set([actor]);
      let target: string | undefined = request.to;
      while (target) {
        if (seen.has(target)) throw new Error('Circular wait: continue independent work or answer the pending peer request first');
        seen.add(target); target = waits.find(row => row.participant === target)?.target;
      }
      return await new Promise((resolve, reject) => {
        let checking = false;
        let dirty = false;
        let finished = false;
        const finish = (rows: ChatMessage[]) => { if (!finished) { finished = true; stop(); resolve(rows); } };
        const check = async () => {
          if (finished) return;
          if (checking) { dirty = true; return; }
          dirty = false;
          checking = true;
          try {
            const rows = await this.responses(requestId);
            if (rows.length || ['expired', 'cancelled'].includes((await this.get(requestId)).status)) finish(rows);
          } catch (error) { finished = true; stop(); reject(error); }
          finally { checking = false; if (dirty && !finished) void check(); }
        };
        const unsubscribe = this.subscribe(() => { void check(); });
        const timer = setTimeout(() => finish([]), Math.max(0, until - Date.now()));
        const abort = () => finish([]);
        stop = () => { unsubscribe(); clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else void check();
      });
    } finally { stop(); await this.files.remove('waits', actor); }
  }
  async stopSession(sessionId: string): Promise<void> {
    for (const peer of await this.files.list<ChatParticipant>('participants')) {
      if (peer.sessionId === sessionId) await this.register({ ...peer, state: 'stopped' });
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
