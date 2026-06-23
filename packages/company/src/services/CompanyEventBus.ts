/**
 * Internal pub/sub for the orchestrator's lifecycle services.
 *
 * Distinct from `MetaBusPublisher`:
 *   - `MetaBusPublisher` publishes outward — SSE consumers (the dashboard,
 *     external integrations) receive its events through `MetaBusWirer`.
 *   - `CompanyEventBus` is INTERNAL. Only `MasterLifecycle`,
 *     `SubordinateLifecycle`, `HumanInTheLoop`, and `IdleController` write
 *     to and read from it; nothing leaves the orchestrator instance.
 *
 * Motivation: the four services used to know each other directly via
 * mutually-recursive `deps` objects with `undefined as unknown as X`
 * placeholders that got filled mid-construction. That pattern is a
 * permanent invitation for "I forgot to fill it in" bugs and made the
 * orchestrator constructor hard to reorder. With this bus the services
 * become loosely coupled: each one publishes the events it generates
 * and subscribes to the ones it cares about, and the orchestrator just
 * wires them all up to the same bus instance.
 *
 * Channels are intentionally narrow — we only model the cross-service
 * transitions that previously required direct refs. Same-service
 * concerns (master.notify pushing to its own runner, HumanInTheLoop
 * wiring runner-level listeners) stay direct because there's no cycle
 * to break.
 */

export type CompanyInternalEvent =
  /** Master finished a runCoder cycle — covers normal, error, and abort exits. */
  | { type: 'master.ended' }
  /** Master is being resurrected (subordinate notified an exited master). */
  | { type: 'master.resurrected' }
  /** A user message arrived for the master — reset idle countdown. */
  | { type: 'user.message_received' }
  /** Number of running subordinates changed — IdleController re-evaluates. */
  | { type: 'subordinates.changed' }
  /**
   * Master inbox drain delivered one or more queued messages from
   * subordinates. Phase A "living company" — listened by the transcript
   * SSE (Phase B) so the dashboard can show the master's incoming feed.
   */
  | {
      type: 'master.inbox_received';
      messageIds: number[];
      fromRoles: string[];
    }
  /**
   * Emitted by `MasterInboxRouter` after a routeMutex timeout reset.
   * Tells observers (dashboard, audit log) that the previous in-flight
   * delivery never settled and we forced the chain to a fresh state.
   * `reason` carries the diagnostic label for now ('mutex_timeout').
   */
  | {
      type: 'master.inbox_router_recovered';
      reason: 'mutex_timeout';
    };

export type CompanyInternalEventType = CompanyInternalEvent['type'];

type Handler = (event: CompanyInternalEvent) => void;

export class CompanyEventBus {
  private readonly handlers = new Map<CompanyInternalEventType, Set<Handler>>();

  /** Publish an event. Synchronous — handlers run in subscription order. */
  emit(event: CompanyInternalEvent): void {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const h of set) {
      try {
        h(event);
      } catch (e) {
        // A single bad subscriber must not break the rest. Surface but
        // don't propagate — the lifecycle services rely on this bus
        // being best-effort.
        console.warn(
          `[CompanyEventBus] handler for '${event.type}' threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * Subscribe to one event type. Returns an unsubscribe function.
   *
   * Handlers run synchronously inside `emit`, so a handler that throws
   * is logged and the next handler runs — see the rationale in `emit`.
   */
  on(type: CompanyInternalEventType, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(type);
    };
  }

  /** Test/diagnostic helper — count active subscribers for a channel. */
  listenerCount(type: CompanyInternalEventType): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}
