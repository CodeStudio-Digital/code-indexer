import type { CodeIndexDB } from '@mcp/store/db.js';
import {
  SemanticStore,
  semanticPurposeForNamespace,
  type SemanticJobRow,
  type SemanticPurpose,
} from '@mcp/store/semantic-store.js';
import {
  createDurableSemanticMutationSink,
  type SemanticMutationSink,
} from '@mcp/services/semantic-mutation-sink.js';
import { loadConfig, type IndexerConfig } from '@mcp/shared/utils/config.js';

type FetchLike = typeof fetch;

interface LocalServerResult {
  reached: boolean;
  ok: boolean;
  status: number | null;
  body: unknown;
  error: string | null;
}

interface SemanticWakeResult {
  job: SemanticJobRow | null;
  skipped: 'disabled' | null;
  server: LocalServerResult | null;
}

function loopbackBaseUrl(config: IndexerConfig): string {
  const configured = config.dashboard.host.trim();
  const host = configured === '0.0.0.0' || configured === '::' || configured === '[::]'
    ? '127.0.0.1'
    : configured;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketed}:${config.dashboard.port}`;
}

/** Best-effort wake-up of the already-running localhost server. Durability is
 * always established in SQLite before this function is called; a failed HTTP
 * request therefore changes latency only, never correctness. */
export async function requestLocalServer(
  path: string,
  init: RequestInit,
  options: {
    config?: IndexerConfig;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<LocalServerResult> {
  const config = options.config ?? loadConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${loopbackBaseUrl(config)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { /* an empty body is valid */ }
    return {
      reached: true,
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok
        ? null
        : (body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `server returned HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      reached: false,
      ok: false,
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Real CLI mutation sink: SnapshotService writes durable deltas instead of
 * silently degrading to its optional no-op integration. */
export function createCliSemanticMutationSink(
  db: CodeIndexDB,
  options: {
    wake?: (namespace: string) => void | Promise<void>;
  } = {},
): SemanticMutationSink {
  const semanticStore = new SemanticStore(db.raw());
  return createDurableSemanticMutationSink(semanticStore, {
    owner: `cli:${process.pid}:${Math.random().toString(16).slice(2)}`,
    enabled: (namespace) => semanticStore.getProfile(
      semanticPurposeForNamespace(namespace),
    )?.embedding_target.kind !== 'disabled',
    // The namespace delta is the durable hand-off. The targeted wake only
    // reduces latency for an already-active namespace; it never starts a
    // generation-less namespace or fans out into a profile-wide rebuild.
    onDurableMutation: (namespace, phase) => {
      if (phase === 'started') return;
      if (options.wake) return options.wake(namespace);
      return requestLocalServer(
        '/api/semantic/namespaces/reconcile',
        { method: 'POST', body: JSON.stringify({ namespace }) },
      ).then(() => undefined);
    },
  });
}

/** Enqueue first, then poke the existing dispatcher. If no server owns the
 * worker right now, the coalesced job remains durable until an explicit
 * dispatcher wake-up occurs. */
export async function queueSemanticReindex(
  db: CodeIndexDB,
  purpose: SemanticPurpose,
  options: Parameters<typeof requestLocalServer>[2] = {},
): Promise<SemanticWakeResult> {
  const semanticStore = new SemanticStore(db.raw());
  if (semanticStore.getProfile(purpose)?.embedding_target.kind === 'disabled') {
    return { job: null, skipped: 'disabled', server: null };
  }
  const job = semanticStore.enqueueReindexJob(purpose);
  const server = await requestLocalServer(
    `/api/admin/semantic/profiles/${purpose}/reindex`,
    { method: 'POST' },
    options,
  );
  return { job, skipped: null, server };
}

/** Publish the central tombstone before contacting the owner process. There
 * is deliberately no local unlink fallback: an unavailable server means the
 * project and FTS remain intact until the worker can drain safely. */
export async function requestProjectRemoval(
  db: CodeIndexDB,
  projectId: number,
  options: Parameters<typeof requestLocalServer>[2] = {},
): Promise<{ marker: SemanticJobRow; completed: boolean; server: LocalServerResult }> {
  const semanticStore = new SemanticStore(db.raw());
  const marker = semanticStore.requestProjectRemoval({
    projectId,
    requestedBy: 'cli',
    finalizeProject: true,
  });
  const server = await requestLocalServer(
    `/api/projects/${projectId}`,
    { method: 'DELETE' },
    options,
  );
  return { marker, completed: server.ok, server };
}
