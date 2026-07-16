import { loadConfig, type IndexerConfig } from '@mcp/shared/utils/config.js';
import type { SemanticStore } from '@mcp/store/semantic-store.js';
import {
  createDurableSemanticMutationSink,
  type SemanticMutationSink,
} from '@mcp/services/semantic-mutation-sink.js';

type FetchLike = typeof fetch;

export interface McpLocalServerResult {
  reached: boolean;
  ok: boolean;
  status: number | null;
  body: unknown;
  error: string | null;
}

function loopbackBaseUrl(config: IndexerConfig): string {
  const configured = config.dashboard.host.trim();
  const host = configured === '0.0.0.0' || configured === '::' || configured === '[::]'
    ? '127.0.0.1'
    : configured;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketed}:${config.dashboard.port}`;
}

/** The stdio MCP process never owns index/vector handles. All mutating work
 * is delegated to the localhost server, which owns worker threads and locks. */
export async function requestMcpLocalServer(
  path: string,
  init: RequestInit,
  options: {
    config?: IndexerConfig;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<McpLocalServerResult> {
  const config = options.config ?? loadConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(`${loopbackBaseUrl(config)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { /* empty response */ }
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

/** Durable sink used by save_memory and any future MCP snapshot writer.
 * The namespace delta/fence is the complete crash-safe hand-off. It never
 * emits a profile-wide reindex wake-up; an active namespace can be reconciled
 * by a targeted owner wake, while a generation-less namespace waits for the
 * operator's explicit first build. */
export function createMcpSemanticMutationSink(
  semanticStore: SemanticStore,
  options: {
    wake?: (namespace: string) => void | Promise<void>;
  } = {},
): SemanticMutationSink {
  return createDurableSemanticMutationSink(semanticStore, {
    owner: `mcp:${process.pid}:${Math.random().toString(16).slice(2)}`,
    enabled: () => semanticStore.getProfile('knowledge')?.embedding_target.kind !== 'disabled',
    // Do not wake the profile-wide reindex endpoint here. The targeted owner
    // wake reconciles only an already-active namespace; generation-less
    // namespaces still wait for an explicit first build.
    onDurableMutation: (namespace, phase) => {
      if (phase === 'started') return;
      if (options.wake) return options.wake(namespace);
      return requestMcpLocalServer(
        '/api/semantic/namespaces/reconcile',
        { method: 'POST', body: JSON.stringify({ namespace }) },
      ).then(() => undefined);
    },
  });
}
