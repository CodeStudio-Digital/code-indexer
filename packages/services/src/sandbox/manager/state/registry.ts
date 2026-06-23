import type { Sandbox } from '../../types.js';

/**
 * Compose the composite key used to address secondary services in the
 * services map. Format `<sessionId>:<serviceId>`. Centralised here so
 * the prefix-scan logic in `listServicesForSession` matches the writer.
 */
export function serviceKey(sessionId: string, serviceId: string): string {
  return `${sessionId}:${serviceId}`;
}

/**
 * In-memory registry of live sandboxes. Owns two maps:
 *   - `primary`: keyed by sessionId, one per session (the dev container).
 *   - `services`: keyed by `${sessionId}:${serviceId}`, zero or more
 *     secondary containers (e.g. workers, microservices).
 *
 * The two are kept separate so primary-only paths (reaper, idle TTL,
 * orphan reconciliation) don't accidentally enumerate services.
 */
export class SandboxRegistry {
  readonly primary = new Map<string, Sandbox>();
  readonly services = new Map<string, Sandbox>();

  // ── primary
  getPrimary(sessionId: string): Sandbox | undefined {
    return this.primary.get(sessionId);
  }
  hasPrimary(sessionId: string): boolean {
    return this.primary.has(sessionId);
  }
  listPrimaries(): Sandbox[] {
    return [...this.primary.values()];
  }

  // ── services
  getService(sessionId: string, serviceId: string): Sandbox | undefined {
    return this.services.get(serviceKey(sessionId, serviceId));
  }
  setService(sessionId: string, serviceId: string, sb: Sandbox): void {
    this.services.set(serviceKey(sessionId, serviceId), sb);
  }
  deleteService(sessionId: string, serviceId: string): void {
    this.services.delete(serviceKey(sessionId, serviceId));
  }

  /** Every secondary service belonging to a session (primary excluded). */
  listServicesForSession(sessionId: string): Sandbox[] {
    const prefix = `${sessionId}:`;
    const out: Sandbox[] = [];
    for (const [key, sb] of this.services.entries()) {
      if (key.startsWith(prefix)) out.push(sb);
    }
    return out;
  }

  /**
   * Like `listServicesForSession` but pairs each sandbox with the
   * `serviceId` recovered from the composite key. Consumers that bind
   * services by id (e.g. `SandboxService.serviceBindings` rehydration)
   * use this to avoid a DB round-trip.
   */
  listServicesWithIdsForSession(
    sessionId: string,
  ): Array<{ serviceId: string; sandbox: Sandbox }> {
    const prefix = `${sessionId}:`;
    const out: Array<{ serviceId: string; sandbox: Sandbox }> = [];
    for (const [key, sb] of this.services.entries()) {
      if (!key.startsWith(prefix)) continue;
      out.push({ serviceId: key.slice(prefix.length), sandbox: sb });
    }
    return out;
  }
}
