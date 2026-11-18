import { randomUUID } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { AgentMemoryEvolutionStore, type MemoryEvolutionScope } from '@mcp/store/db/agent-memory-evolution.js';
import type { AgentMemoryRow } from '@mcp/shared/types.js';
import type { AgentMemoryService } from './agent-memory-service.js';
import { applyMemoryEvolution } from './evolution-apply.js';
import { proposeMemoryEvolution, protectedMemory, type MemoryEvolutionPlan } from './evolution-plan.js';
import type { DistillCallDeps } from './distill-call.js';

interface EvolutionOptions {
  db: CodeIndexDB; service: AgentMemoryService; distill: DistillCallDeps;
  isConfigured: () => Promise<boolean>;
  enabled?: () => boolean;
  now?: () => number;
  cooldownMs?: number;
  propose?: (rows: AgentMemoryRow[], signal: AbortSignal) => Promise<MemoryEvolutionPlan>;
}

export function memoryEvolutionError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthor|credential/i.test(text)) return 'authentication';
  if (/429|rate.?limit|quota/i.test(text)) return 'rate_limit';
  if (/abort|timeout|timed out/i.test(text)) return 'timeout';
  if (/JSON|Zod|parse|operations/i.test(text)) return 'invalid_response';
  if (/lease_lost/.test(text)) return 'lease_lost';
  if (/SQLITE_BUSY|locked/.test(text)) return 'storage_busy';
  return 'provider_unavailable';
}

/** One background job at a time. New source IDs, not a self-generated loop,
 * drive maintenance; cursors, leases and backoff survive application restarts. */
export class AgentMemoryEvolution {
  readonly store: AgentMemoryEvolutionStore;
  private readonly shutdown = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private initial: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private readonly requested = new Map<string, MemoryEvolutionScope>();
  constructor(private readonly opts: EvolutionOptions) { this.store = new AgentMemoryEvolutionStore(opts.db.raw()); }
  private now(): number { return this.opts.now?.() ?? Date.now(); }
  enabled(key?: MemoryEvolutionScope): boolean {
    return !this.shutdown.signal.aborted && (this.opts.enabled?.() ?? process.env.MCP_MEMORY_EVOLVE !== '0')
      && (!key || this.opts.db.getProjectMemoryEnabled(key.projectId));
  }
  status(key: MemoryEvolutionScope) { return { ...this.store.status(key, this.now()), enabled: this.enabled(key), queued: this.requested.has(`${key.scope}:${key.projectId}`) }; }

  start(): void {
    if (this.timer || this.shutdown.signal.aborted) return;
    // No history walks, embedding rebuilds or model calls on every UI poll.
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, 60_000);
    this.initial = setTimeout(() => { void this.runOnce().catch(() => undefined); }, 30_000);
    this.timer.unref(); this.initial.unref();
  }
  async stop(): Promise<void> {
    this.shutdown.abort(); this.requested.clear(); clearInterval(this.timer); clearTimeout(this.initial);
    await this.inFlight?.catch(() => undefined);
  }
  async runOnce(only?: MemoryEvolutionScope): Promise<void> {
    if (!this.enabled(only)) return;
    if (only) this.requested.set(`${only.scope}:${only.projectId}`, only);
    if (this.inFlight) return;
    const run = async () => {
      const manual = [...this.requested.values()];
      const scopes = [...manual, ...(only ? [] : this.store.pendingScopes(this.now(), 2))]
        .filter((key, index, all) => all.findIndex(item => item.scope === key.scope && item.projectId === key.projectId) === index).slice(0, 2);
      for (const key of scopes) {
        const force = this.requested.delete(`${key.scope}:${key.projectId}`);
        if (!this.enabled(key) || this.store.status(key, this.now()).pending === 0) continue;
        await this.review(key, force);
      }
    };
    this.inFlight = run();
    try { await this.inFlight; } finally {
      this.inFlight = null;
      if (this.requested.size && !this.shutdown.signal.aborted) queueMicrotask(() => { void this.runOnce().catch(() => undefined); });
    }
  }

  private async review(key: MemoryEvolutionScope, force: boolean): Promise<void> {
    const { db, service } = this.opts;
    const token = randomUUID();
    if (!await service.runRelationalWrite(() => this.store.claim(key, token, this.now(), force))) return;
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(90_000)]);
    try {
      const sources = this.store.sources(key);
      const candidates = new Map<number, AgentMemoryRow>();
      let chars = 0;
      const add = (row: AgentMemoryRow) => {
        if (row.archived_at || row.scope !== key.scope || row.project_id !== key.projectId || candidates.has(row.id)
          || row.content.length > 8000 || chars + row.content.length > 48_000 || candidates.size >= 24) return;
        candidates.set(row.id, row); chars += row.content.length;
      };
      sources.forEach(add);
      let plan: MemoryEvolutionPlan = { operations: [] };
      if (sources.some(row => row.type !== 'preference' && row.type !== 'external_pointer')) {
        // At most two hybrid neighbor searches. No additional LLM query/filter,
        // no all-pairs embedding pass, and no network calls inside a DB lock.
        for (const source of sources.filter(row => row.type !== 'preference' && row.type !== 'external_pointer').slice(0, 2)) {
          signal.throwIfAborted();
          const neighbors = await service.search(key.scope, key.projectId, `${source.name}\n${source.content}`.slice(0, 1000),
            8, source.type, signal, { deduplicate: false, rerank: false });
          neighbors.forEach(add);
        }
        const rows = [...candidates.values()];
        if (rows.some(row => !protectedMemory(row))) {
          if (!await this.opts.isConfigured()) throw new Error('provider_unavailable');
          plan = this.opts.propose ? await this.opts.propose(rows, signal)
            : await proposeMemoryEvolution({ ...this.opts.distill, signal }, rows);
        }
      }
      signal.throwIfAborted();
      await service.runMutationBatch(() => service.runRelationalWrite(() => db.transaction(() => {
        signal.throwIfAborted();
        if (!this.enabled(key)) throw new Error('memory_evolution_aborted');
        this.store.assertOwned(key, token, this.now());
        const result = { reviewed: sources.length, ...applyMemoryEvolution(db, service, key, [...candidates.values()], plan) };
        this.store.complete(key, token, sources.at(-1)?.id ?? this.store.read(key)!.cursor_id, result,
          this.now(), this.opts.cooldownMs ?? 300_000);
      })));
    } catch (error) {
      const code = memoryEvolutionError(error);
      await service.runRelationalWrite(() => this.store.fail(key, token, code, this.now())).catch(() => undefined);
      console.warn(`[memory/evolution] ${key.scope}:${key.projectId} paused (${code})`);
    }
  }
}
