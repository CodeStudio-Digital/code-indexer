/**
 * Auto-discovery wired to the indexer — after a project (re-)index
 * completes, scan its manifests (package.json, requirements.txt, …) and
 * persist doc-source suggestions. Until now `AutoDiscoveryService.scan`
 * only ran when the operator opened the dashboard's Suggestions tab.
 *
 * CRITICAL: `IndexAgent` AWAITS its files_updated listeners
 * (indexer-events.ts), and a scan resolves registry URLs at 2 req/s —
 * a large package.json could hold the index-run completion for minutes.
 * The scan is therefore fire-and-forget (`void`), and a per-project
 * debounce keeps frequent re-indexes from hammering the registries.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type {
  IndexerFilesUpdatedEvent,
  IndexerFilesUpdatedListener,
} from '@mcp/indexer/indexer/indexer-events.js';
import { AutoDiscoveryService } from './auto-discovery.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/** Re-scan a project's manifests at most every 6h (manual scan stays instant). */
const DEFAULT_DEBOUNCE_MS = 6 * 60 * 60 * 1000;

export interface AutoDiscoveryListenerOpts {
  /** SQLite handle backing `doc_source_suggestions`. */
  db: DB;
  /** Resolve a project id to its absolute root path (null skips the scan). */
  getProjectRoot: (projectId: number) => string | null;
  debounceMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export function makeAutoDiscoveryIndexListener(
  opts: AutoDiscoveryListenerOpts,
): IndexerFilesUpdatedListener {
  const log = opts.log ?? ((_l: string, msg: string) => console.warn(`[auto-discovery] ${msg}`));
  const service = new AutoDiscoveryService({ db: opts.db, log: opts.log });
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const lastScanAt = new Map<number, number>();

  return (event: IndexerFilesUpdatedEvent): void => {
    if (event.status === 'failed') return;
    const now = Date.now();
    if (now - (lastScanAt.get(event.projectId) ?? 0) < debounceMs) return;
    lastScanAt.set(event.projectId, now);

    const projectRoot = opts.getProjectRoot(event.projectId);
    if (!projectRoot) return;

    // Deliberately NOT awaited — see module docblock.
    void service
      .scan({ projectId: event.projectId, projectRoot })
      .then((r) => {
        if (r.suggestionsInserted > 0) {
          log('info', `post-index scan: ${r.suggestionsInserted} new doc suggestions for project ${event.projectId}`);
        }
      })
      .catch((err: unknown) => {
        log('warn', `post-index scan failed for project ${event.projectId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  };
}

/**
 * Compose several files_updated listeners into one. Each is awaited in
 * order with its own try/catch so one failure can't starve the others —
 * IndexAgent already swallows listener throws, but only per-listener-slot.
 */
export function composeFilesUpdatedListeners(
  ...listeners: Array<IndexerFilesUpdatedListener | undefined>
): IndexerFilesUpdatedListener | undefined {
  const actual = listeners.filter((l): l is IndexerFilesUpdatedListener => l != null);
  if (actual.length === 0) return undefined;
  if (actual.length === 1) return actual[0];
  return async (event) => {
    for (const listener of actual) {
      try {
        await listener(event);
      } catch {
        // Per-listener isolation; IndexAgent logs at its own layer.
      }
    }
  };
}
