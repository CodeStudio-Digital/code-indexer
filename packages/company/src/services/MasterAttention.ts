/** In-process signal used by explicit, targeted waits and inbox replies.
 * MasterLifecycle queues background updates independently of these listeners. */
export type AttentionKind =
  | 'question' | 'plan' | 'tasks' | 'finished' | 'inbox_answered' | 'user_message' | 'notify';

export interface AttentionEvent {
  kind: AttentionKind;
  agentRunId: string | null;
  role: string;
}

export type AttentionListener = (ev: AttentionEvent) => void;

export class MasterAttention {
  private readonly listeners = new Set<AttentionListener>();

  /**
   * Subscribe to attention events. Returns an unsubscribe function.
   * Callers must unsubscribe on every exit path (resolve, timeout, reject)
   * to avoid dangling references.
   */
  on(listener: AttentionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  signal(ev: AttentionEvent): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* swallow — listeners must not break signalers */ }
    }
  }
}
