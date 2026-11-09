import { apiPost } from '../useApi.js';

export interface ProviderSelection { provider: string; model: string }
export interface ProviderSwitchState {
  selection: ProviderSelection;
  pending: boolean;
  error: string | null;
}

/** One ordering authority for Chat and Editor consumers of the same session. */
export class ProviderSwitchCoordinator {
  private readonly states = new Map<string, ProviderSwitchState>();
  private readonly tails = new Map<string, Promise<ProviderSelection>>();
  private readonly listeners = new Map<string, Set<() => void>>();

  snapshot = (id: string): ProviderSwitchState | null => this.states.get(id) ?? null;

  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  private publish(id: string, state: ProviderSwitchState): void {
    this.states.set(id, state);
    this.listeners.get(id)?.forEach((listener) => listener());
  }

  change(
    id: string,
    selection: ProviderSelection,
    write: () => Promise<ProviderSelection>,
  ): Promise<ProviderSelection> {
    const previous = this.tails.get(id);
    const operation = (previous ?? Promise.resolve()).catch(() => undefined).then(write);
    this.tails.set(id, operation);
    this.publish(id, { selection, pending: true, error: null });
    // Attach a rejection handler immediately, including for fire-and-forget UI
    // changes. wait() still rejects a failed latest change; it never sends old.
    void operation.then((confirmed) => {
      if (this.tails.get(id) !== operation) return;
      this.publish(id, { selection: confirmed, pending: false, error: null });
    }, (error: unknown) => {
      if (this.tails.get(id) !== operation) return;
      this.publish(id, {
        selection, pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return operation;
  }

  async wait(id: string): Promise<void> {
    let tail = this.tails.get(id);
    while (tail) {
      try { await tail; }
      catch (error) { if (this.tails.get(id) === tail) throw error; }
      const latest = this.tails.get(id);
      if (latest === tail) return;
      tail = latest;
    }
  }

  forget(id: string): void {
    this.tails.delete(id);
    this.states.delete(id);
    this.listeners.get(id)?.forEach(listener => listener());
  }
}

export const sessionProviderSwitches = new ProviderSwitchCoordinator();

export function switchSessionProvider(id: string, provider: string, model = ''): Promise<ProviderSelection> {
  return sessionProviderSwitches.change(id, { provider, model }, async () => {
    const response = await apiPost<{ ok?: boolean; provider?: string; model?: string }>(
      `/coder/sessions/${id}/switch`, { provider, model: model || undefined },
    );
    if (response.ok !== true || response.provider !== provider || !response.model?.trim()) {
      throw new Error('The server did not confirm the selected provider and model.');
    }
    return { provider: response.provider, model: response.model };
  });
}
