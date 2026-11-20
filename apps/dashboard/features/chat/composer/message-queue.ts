import type { AgentAttachment } from '../types.js';

export type QueueMode = 'next-turn' | 'end-of-session';
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: AgentAttachment[];
  skillIds?: string[];
  mode: QueueMode;
  status: 'pending' | 'sending' | 'accepted' | 'error';
  messageId?: number;
  error?: string;
}
export interface QueueRunState { streaming: boolean; doneReason: string | null; error: string | null; consumedMessageIds?: number[] }
export type QueueDeliver = (text: string, opts: {
  clientMessageId: string;
  interject: boolean;
  attachments?: AgentAttachment[];
  skillIds?: string[];
}) => Promise<'accepted' | 'busy' | { acceptedMessageId: number }>;
export interface QueueSnapshot { items: QueuedMessage[]; paused: boolean; restoring: boolean; storageError?: string }
export class MessageNotStartedError extends Error {}

/** One serialized outbox per conversation, independent of React mount/unmount. */
export class MessageQueue {
  private snapshot: QueueSnapshot = { items: [], paused: false, restoring: false };
  private listeners = new Set<() => void>();
  private running = false;
  private disposed = false;
  private scheduled = false;
  private readonly explicitSends = new Set<string>();
  private runState: QueueRunState;
  private persistence: Promise<void> = Promise.resolve();
  deliver: QueueDeliver;

  constructor(private readonly opts: {
    deliver: QueueDeliver;
    state: QueueRunState;
    save?: (items: QueuedMessage[]) => Promise<void>;
    newId?: () => string;
  }) {
    this.deliver = opts.deliver;
    this.runState = opts.state;
  }

  getSnapshot = (): QueueSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<QueueSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.items && this.opts.save) {
      const items = patch.items;
      this.persistence = this.persistence.then(() => this.opts.save!(items)).then(() => {
        if (this.snapshot.storageError) this.update({ storageError: undefined });
      }, () => { this.update({ storageError: 'queue-storage-unavailable' }); });
    }
    for (const listener of this.listeners) listener();
  }

  async restore(load: () => Promise<QueuedMessage[]>): Promise<void> {
    this.update({ restoring: true });
    try {
      const stored = await load();
      if (this.disposed) return;
      // Reload is never an instruction to resend an unacknowledged operation.
      this.update({ items: stored.map(item => ({ ...item, status: item.status === 'pending' ? 'pending' : 'error',
        ...(item.status !== 'pending' ? { error: 'queue-delivery-unconfirmed' } : {}) })), paused: stored.length > 0 });
    } catch { this.update({ storageError: 'queue-storage-unavailable' }); }
    finally { this.update({ restoring: false }); }
  }

  setRunState(state: QueueRunState): void {
    const previous = this.runState;
    this.runState = state;
    const remaining = this.snapshot.items.filter(item => item.status !== 'accepted'
      || (state.streaming && !state.consumedMessageIds?.includes(item.messageId!)));
    if (remaining.length !== this.snapshot.items.length) this.update({ items: remaining });
    if (previous.streaming && !state.streaming && (state.error || state.doneReason !== 'completed')) this.pause();
    if (previous.streaming !== state.streaming) this.schedule();
  }

  enqueue(text: string, mode: QueueMode, attachments?: AgentAttachment[], skillIds?: string[]): boolean {
    if (this.disposed || this.snapshot.restoring || (!text.trim() && !attachments?.length)) return false;
    const id = this.opts.newId?.() ?? globalThis.crypto.randomUUID();
    if (mode === 'next-turn') this.explicitSends.add(id);
    this.update({ ...(this.snapshot.items.length ? {} : { paused: false }),
      items: [...this.snapshot.items, { id, text, mode, attachments, skillIds, status: 'pending' }] });
    this.schedule();
    return true;
  }

  promote = (id: string): void => {
    const item = this.snapshot.items.find(value => value.id === id);
    if (!item || this.explicitSends.has(id) || item.status === 'sending' || item.status === 'accepted') return;
    this.explicitSends.add(id);
    // An uncertain retry must preserve the complete idempotent request, including only_when_idle.
    const mode = item.status === 'error' ? item.mode : 'next-turn';
    this.update({ items: this.snapshot.items.map(value => value.id === id
      ? { ...value, mode, status: 'pending', error: undefined } : value) });
    this.schedule();
  };
  remove = (id: string): void => {
    this.update({ items: this.snapshot.items.filter(item => item.id !== id || item.status === 'sending' || item.status === 'accepted') });
  };
  pause = (): void => { this.explicitSends.clear(); if (!this.snapshot.paused) this.update({ paused: true }); };
  resume = (): void => { this.update({ paused: false }); this.schedule(); };
  dispose(): void { this.disposed = true; this.update({ items: [] }); this.listeners.clear(); }

  private schedule(): void {
    if (this.scheduled || this.running || this.disposed || this.snapshot.restoring) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.pump(); });
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed || this.snapshot.restoring) return;
    // Steering may bypass parked tasks, but two steering requests never race.
    const immediate = this.snapshot.items.find(item => item.status === 'pending'
      && (this.explicitSends.has(item.id) || (!this.snapshot.paused && item.mode === 'next-turn')));
    const first = this.snapshot.items.find(item => item.mode === 'end-of-session');
    const item = immediate ?? (!this.snapshot.paused && !this.runState.streaming && first?.status === 'pending' ? first : undefined);
    if (!item) return;
    this.running = true;
    this.update({ items: this.snapshot.items.map(value => value.id === item.id ? { ...value, status: 'sending' } : value) });
    try {
      await this.persistence;
      if (this.disposed) return;
      if (this.snapshot.paused && !this.explicitSends.has(item.id)) {
        this.update({ items: this.snapshot.items.map(value => value.id === item.id ? { ...value, status: 'pending' } : value) });
        return;
      }
      const result = await this.deliver(item.text, { clientMessageId: item.id, interject: item.mode === 'next-turn', attachments: item.attachments, skillIds: item.skillIds });
      if (this.disposed) return;
      if (result === 'busy') {
        this.explicitSends.delete(item.id);
        // The server explicitly declined admission. A raced admission may have
        // terminalized the old command key, so the later attempt gets a new ID.
        this.update({ items: this.snapshot.items.map(value => value.id === item.id
          ? { ...value, id: this.opts.newId?.() ?? globalThis.crypto.randomUUID(), status: 'pending' } : value) });
        return;
      }
      this.explicitSends.delete(item.id);
      const waitingForBoundary = typeof result === 'object' && this.runState.streaming
        && !this.runState.consumedMessageIds?.includes(result.acceptedMessageId);
      this.update({ items: waitingForBoundary
        ? this.snapshot.items.map(value => value.id === item.id ? { ...value, status: 'accepted', messageId: result.acceptedMessageId } : value)
        : this.snapshot.items.filter(value => value.id !== item.id) });
    } catch (error) {
      this.pause();
      if (!this.disposed) {
        // A confirmed pre-start refusal has consumed this command ID. Only an
        // explicit retry should create work. Unknown delivery keeps its original ID.
        const retryId = error instanceof MessageNotStartedError ? this.opts.newId?.() ?? globalThis.crypto.randomUUID() : item.id;
        this.update({ paused: true, items: this.snapshot.items.map(value => value.id === item.id
          ? { ...value, id: retryId, status: 'error', error: error instanceof Error ? error.message : String(error) } : value) });
      }
    } finally { this.running = false; }
    this.schedule();
  }
}
