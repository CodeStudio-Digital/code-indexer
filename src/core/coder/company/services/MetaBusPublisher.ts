/**
 * MetaBusPublisher — thin adapter over the functional coder-bus API so
 * services depend on a small injected port instead of free functions.
 *
 * Responsibilities:
 *   - `publish(event, data)` — buffered + fanned out to subscribers
 *   - `markEnded(event, data)` — terminates the bus for reattach clients
 *
 * Services call this instead of importing `publish`/`markEnded` from the
 * bus module directly — which keeps the test surface small (inject a
 * fake port) and the coupling one-way.
 */

import type { CoderRunBus } from '../../../../apps/http-api/coder-bus.js';
import { publish as busPublish, markEnded as busMarkEnded } from '../../../../apps/http-api/coder-bus.js';
import type { IMetaBusPublisher } from './ports.js';

export class MetaBusPublisher implements IMetaBusPublisher {
  constructor(readonly bus: CoderRunBus) {}

  publish(event: string, data: unknown): void {
    busPublish(this.bus, event, data);
  }

  markEnded(event: 'done' | 'error', data: unknown): void {
    busMarkEnded(this.bus, event, data);
  }
}
