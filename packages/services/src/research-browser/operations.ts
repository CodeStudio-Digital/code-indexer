interface Operation {
  readonly key: string;
  readonly controller: AbortController;
  readonly done: Promise<unknown>;
  started: boolean;
}

/** Serializes one page's commands without blocking unrelated browser sessions.
 * Reservations exist before DNS/context creation, so cancellation also fences
 * an open operation that has not published a page yet. */
export class ResearchBrowserOperations {
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Operation>();
  private readonly requests = new Map<string, Operation>();
  private readonly closing = new Map<string, Promise<unknown>>();
  private readonly failedCleanup = new Set<string>();

  keys(): string[] { return [...new Set([...this.lanes.keys(), ...this.failedCleanup])]; }

  run<T>(key: string, requestId: string | undefined, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (requestId && this.requests.has(requestId)) return Promise.reject(new Error('Duplicate browser request ID.'));
    if (this.pending.size >= 256 || [...this.pending].filter(item => item.key === key).length >= 32) {
      return Promise.reject(new Error('Research browser request queue is full.'));
    }
    const controller = new AbortController();
    const previous = this.lanes.get(key) ?? Promise.resolve();
    let operation!: Operation;
    const done = previous.catch(() => undefined).then(() => {
      controller.signal.throwIfAborted();
      if (this.failedCleanup.has(key)) throw new Error('Research browser cleanup is unconfirmed. Close the session before reopening.');
      operation.started = true;
      return invoke(controller.signal);
    }).finally(() => {
      this.pending.delete(operation);
      if (requestId && this.requests.get(requestId) === operation) this.requests.delete(requestId);
      if (this.lanes.get(key) === done) this.lanes.delete(key);
    });
    operation = { key, controller, done, started: false };
    this.pending.add(operation);
    this.lanes.set(key, done);
    if (requestId) this.requests.set(requestId, operation);
    // A caller can time out its transport while the physical operation drains.
    void done.catch(() => undefined);
    return done;
  }

  cancel(requestId: string): { key: string; started: boolean; done: Promise<unknown> } | undefined {
    const operation = this.requests.get(requestId);
    if (!operation) return undefined;
    operation.controller.abort(new Error('Research browser operation aborted.'));
    return operation;
  }

  cancelKey(key: string): Promise<void> {
    const operations = [...this.pending].filter(item => item.key === key);
    for (const operation of operations) operation.controller.abort(new Error('Research browser session closed.'));
    return Promise.allSettled(operations.map(item => item.done)).then(() => undefined);
  }

  close<T>(key: string, release: () => Promise<T>): Promise<T> {
    const existing = this.closing.get(key);
    if (existing) return existing as Promise<T>;
    const drained = this.cancelKey(key);
    const closing = Promise.allSettled([Promise.resolve().then(release), drained]).then(async results => {
      const released = results[0];
      if (released.status === 'rejected') {
        this.failedCleanup.add(key);
        throw released.reason;
      }
      // An uncancellable newContext may have completed after the first close.
      // Its owner retained it even if its own cleanup failed; collect it now.
      try { await release(); }
      catch (error) { this.failedCleanup.add(key); throw error; }
      this.failedCleanup.delete(key);
      return released.value as T;
    }).finally(() => {
      if (this.lanes.get(key) === closing) this.lanes.delete(key);
      this.closing.delete(key);
    });
    this.closing.set(key, closing);
    this.lanes.set(key, closing);
    void closing.catch(() => undefined);
    return closing;
  }
}
