import type { EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';

/** Serializes snapshot consumers, not commits. Closing cancels reads before
 * releasing the writer so HTTP cannot retain a dead storage capability. */
export class NativeWriterHistoryReads {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly stop = new AbortController();

  read<T>(open: () => EngineEventRecoveryStorePort,
    project: (store: EngineEventRecoveryStorePort) => Promise<T>): Promise<T | undefined> {
    const pending = this.tail.then(async () => {
      if (this.stop.signal.aborted) return undefined;
      const source = open();
      const checked: EngineEventRecoveryStorePort = {
        list: async (...args) => {
          this.stop.signal.throwIfAborted();
          const value = await source.list(...args);
          this.stop.signal.throwIfAborted();
          return value;
        },
        read: async (...args) => {
          this.stop.signal.throwIfAborted();
          const value = await source.read(...args);
          this.stop.signal.throwIfAborted();
          return value;
        },
      };
      try { return await project(checked); }
      catch (error) { if (this.stop.signal.aborted) return undefined; throw error; }
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  async close(): Promise<void> { this.stop.abort(); await this.tail; }
}
