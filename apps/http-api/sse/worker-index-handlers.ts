import type { MessageBridge } from '@mcp/orchestrator-host';
import type { SearchMode, SearchType } from '@mcp/shared/types.js';
import { readRequirements } from '@mcp/indexer/indexer/providers/catalog-intent.js';
import {
  searchConsumer,
  type IndexSearchService,
  type TelemetryIds,
} from '../server/index-search-service.js';

/** Same deadline as the loopback semantic client; queue time counts in it. */
const INDEX_SEARCH_DEADLINE_MS = 20_000;
/** HybridSearch has no admission control: agent searches in flight per host. */
export const MAX_AGENT_SEARCHES_IN_FLIGHT = 4;

/** FIFO admission; a cancelled or expired waiter leaves the queue. */
export function createFifoLimiter(max: number) {
  let active = 0;
  const waiting: Array<{ grant: () => void; expire: () => void; signal: AbortSignal; onAbort: () => void }> = [];
  const release = () => { active--; drain(); };
  const drain = () => {
    while (active < max && waiting.length) {
      const next = waiting.shift()!;
      next.signal.removeEventListener('abort', next.onAbort);
      if (next.signal.aborted) { next.expire(); continue; }
      active++;
      next.grant();
    }
  };
  const once = () => { let done = false; return () => { if (!done) { done = true; release(); } }; };
  return {
    acquire(signal: AbortSignal): Promise<() => void> {
      signal.throwIfAborted();
      if (active < max && !waiting.length) { active++; return Promise.resolve(once()); }
      return new Promise((resolve, reject) => {
        const entry = {
          signal,
          grant: () => resolve(once()),
          expire: () => reject(signal.reason),
          onAbort: () => { waiting.splice(waiting.indexOf(entry), 1); reject(signal.reason); },
        };
        waiting.push(entry);
        signal.addEventListener('abort', entry.onAbort, { once: true });
      });
    },
    stats: () => ({ active, queued: waiting.length }),
  };
}

const hostLimiter = createFifoLimiter(MAX_AGENT_SEARCHES_IN_FLIGHT);

type Packet = Record<string, unknown> & { requestId?: unknown };
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : undefined;
const integer = (value: unknown) => Number.isSafeInteger(value) ? value as number : undefined;

/** What the host knows about a worker's sessions, for search telemetry. */
export interface WorkerTelemetryAuthority {
  ids: TelemetryIds;
  /** Keys where the host's id always wins over a claimed one. */
  fixed?: ReadonlyArray<keyof TelemetryIds>;
}

/**
 * Per key, the id the worker claims (as the HTTP headers carry it), else the
 * host's own. The service validates every candidate with the route's
 * validateTelemetryScope; an invalid one is dropped, with no second fallback.
 */
function telemetryCandidates(packet: Packet, authority: WorkerTelemetryAuthority): TelemetryIds {
  const candidates: TelemetryIds = {};
  for (const key of ['sessionId', 'companySessionId'] as const) {
    const claimed = authority.fixed?.includes(key) ? undefined : text(packet[key], 128)?.trim();
    const id = claimed || authority.ids[key];
    if (id) candidates[key] = id;
  }
  return candidates;
}

/**
 * Worker → host index search. Telemetry ids follow the HTTP route's model
 * (telemetryCandidates). Responses travel as the JSON text an HTTP client
 * would read.
 */
export function registerWorkerIndexHandlers(
  bridge: MessageBridge,
  authority: () => WorkerTelemetryAuthority,
  getService: () => IndexSearchService | null | undefined,
  /** Tests only: production uses the host limiter and the 20 s deadline. */
  options: { limiter?: ReturnType<typeof createFifoLimiter>; deadlineMs?: number } = {},
) {
  const limiter = options.limiter ?? hostLimiter;
  const deadlineMs = options.deadlineMs ?? INDEX_SEARCH_DEADLINE_MS;
  const calls = new Map<string, AbortController>();
  let closed = false;
  const run = async (packet: Packet, work: (service: IndexSearchService, signal: AbortSignal) => Promise<unknown>) => {
    const requestId = text(packet?.requestId, 128);
    if (closed || !requestId || calls.has(requestId) || calls.size >= 16) throw new Error('Invalid or saturated index search');
    const controller = new AbortController();
    calls.set(requestId, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs)]);
    try {
      const service = getService();
      if (!service) throw new Error('Index search is not wired into this host');
      const release = await limiter.acquire(signal);
      try {
        signal.throwIfAborted();
        const result = await work(service, signal);
        signal.throwIfAborted();
        return JSON.stringify(result);
      } finally { release(); }
    } finally { calls.delete(requestId); }
  };
  const projectId = (packet: Packet) => {
    const id = integer(packet.projectId);
    if (!id || id < 1) throw new Error('Invalid project id');
    return id;
  };
  const offs = [
    bridge.handle('indexCatalogSearch', payload => run(payload as Packet, (service, signal) => {
      const p = payload as Packet;
      const query = text(p.query, 256), provider = text(p.provider, 256), offset = integer(p.offset), limit = integer(p.limit);
      if (query === undefined || (p.provider !== undefined && !provider?.trim()) || offset === undefined || offset < 0 ||
        !limit || limit < 1 || limit > 500) throw new Error('Invalid model catalog request');
      return service.catalogSearch({ query, provider, offset, limit, requires: readRequirements(p.requires) }, signal);
    })),
    bridge.handle('indexProjectSearch', payload => run(payload as Packet, (service, signal) => {
      const packet = payload as Packet;
      return service.projectSearch({
        projectId: projectId(packet), query: text(packet.query, 1_000_000) ?? '',
        mode: text(packet.mode, 32) as SearchMode | undefined, type: text(packet.type, 32) as SearchType | undefined,
        limit: integer(packet.limit), consumer: searchConsumer(text(packet.consumer, 64)),
      }, telemetryCandidates(packet, authority()), signal);
    })),
    bridge.handle('indexMemorySearch', payload => run(payload as Packet, async (service, signal) => {
      const packet = payload as Packet;
      const outcome = await service.memorySearch(projectId(packet), text(packet.query, 1_000_000) ?? '', integer(packet.limit) ?? 5, signal);
      if (outcome.status !== 200) throw new Error(outcome.error);
      return { results: outcome.results.map(row => ({ id: row.id, score: row.score })) };
    })),
    bridge.handle('indexSemanticReconcile', async payload => {
      const service = getService();
      if (closed || !service) throw new Error('Index search is not wired into this host');
      const outcome = service.reconcile((payload as Packet)?.namespace);
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome;
    }),
    bridge.handle('indexSearchCancel', async payload => {
      calls.get(text((payload as Packet)?.requestId, 128) ?? '')?.abort(new Error('Index search cancelled'));
      return { cancelled: true };
    }),
  ];
  return () => {
    closed = true;
    for (const off of offs) off();
    for (const controller of calls.values()) controller.abort(new Error('Index search bridge closed'));
  };
}
