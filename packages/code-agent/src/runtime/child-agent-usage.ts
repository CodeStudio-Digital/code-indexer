/**
 * Exactly-once accounting of child-agent usage in the parent session. Each
 * completed run of a child, or of any of its descendants, is one key
 * (`child-run:<runId>`). The source is what every child's own worker wrote in
 * its bundle: its run records, plus its conclusion, which is written before
 * the run record completes. The durable "already counted" mark is the
 * parent's own metrics: the turn metric's `subagent_runs` when a tool
 * received the result inside a turn (claimForTurn), or a standalone usage
 * metric whose operation key is the run key (sweep). Only the parent's worker
 * writes either, through its session writer. One ledger per parent run
 * serializes claims and sweeps, so a run waited for twice, received by a wait
 * and by a background notice, or found again after a restart counts once.
 * Every ancestor counts a descendant's run once in its own totals.
 */
import type { FsChildAgentSession, FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { ChatUsage } from '../core/messages.js';
import { childAgentDescendants, type ChildAgentTreeStore } from './child-agent-tree.js';

export const childRunUsageKey = (runId: string): string => `child-run:${runId}`;

export interface ChildAgentRunUsage {
  key: string;
  childId: string;
  runId: string;
  usage: ChatUsage;
  /** The child's changed files, from the conclusion of its newest run (empty for older runs). */
  changedFiles: string[];
}

export interface ChildAgentUsageDeps {
  /** Read-only views of the children's bundles. */
  sessions: ChildAgentTreeStore & Pick<FsSessionStore, 'listSubagentRuns'> & {
    refreshSession?(id: string): Promise<unknown>;
    /**
     * Picks up children the app created after this worker's store scanned;
     * given when children can exist (child chats on), so others pay nothing.
     */
    discoverNewSessions?(): Promise<number>;
  };
  /** The keys the parent's metrics already hold; read once per ledger. */
  accounted(): Promise<ReadonlySet<string>>;
  /** Records usage outside a turn, idempotent by key (the parent's standalone metric). */
  recordStandalone(usage: ChatUsage, key: string): Promise<void>;
}

export interface ChildAgentClaim {
  usage: ChatUsage | null;
  keys: string[];
  runs: ChildAgentRunUsage[];
}

const RUN_PAGE = 100;
const sameId = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

function sum(runs: readonly ChildAgentRunUsage[]): ChatUsage | null {
  if (runs.length === 0) return null;
  const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const { usage } of runs) {
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
    total.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    total.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  }
  return total;
}

export class ChildAgentUsageLedger {
  readonly #parentId: string;
  readonly #deps: ChildAgentUsageDeps;
  /** Durable keys plus the ones claimed by this run's turns. */
  #known: Promise<Set<string>> | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(parentId: string, deps: ChildAgentUsageDeps) {
    this.#parentId = parentId;
    this.#deps = deps;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task, task);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #keys(): Promise<Set<string>> {
    this.#known ??= this.#deps.accounted().then((keys) => new Set(keys));
    try {
      return await this.#known;
    } catch (error) {
      this.#known = null; // read again next time
      throw error;
    }
  }

  async #subtree(childIds?: readonly string[]): Promise<FsChildAgentSession[]> {
    const { sessions } = this.#deps;
    if (!childIds) return childAgentDescendants(sessions, this.#parentId);
    const found: FsChildAgentSession[] = [];
    for (const id of childIds) {
      const child = await sessions.getChildAgentSession(id);
      if (!child || !sameId(child.parent_session_id, this.#parentId)) continue;
      found.push(child, ...await childAgentDescendants(sessions, child.id));
    }
    return found;
  }

  async #runs(childId: string): Promise<ChildAgentRunUsage[]> {
    const { sessions } = this.#deps;
    await sessions.refreshSession?.(childId); // its worker writes through another store instance
    const runs = new Map<string, ChildAgentRunUsage>();
    for (let offset: number | null = 0; offset != null;) {
      const page = await sessions.listSubagentRuns(childId, offset, RUN_PAGE);
      for (const row of page.items) {
        if (row.status !== 'completed') continue; // interrupted runs never recorded their usage
        runs.set(row.run_id, { key: childRunUsageKey(row.run_id), childId, runId: row.run_id, changedFiles: [], usage: {
          input_tokens: row.input_tokens ?? 0, output_tokens: row.output_tokens ?? 0,
          cache_read_input_tokens: row.cache_read_input_tokens ?? 0, cache_creation_input_tokens: row.cache_creation_input_tokens ?? 0,
        } });
      }
      offset = page.nextOffset;
    }
    const done = (await sessions.getChildAgentSession(childId))?.conclusion;
    if (done) {
      runs.set(done.run_id, { key: childRunUsageKey(done.run_id), childId, runId: done.run_id,
        usage: runs.get(done.run_id)?.usage ?? done.usage, changedFiles: done.changed_files });
    }
    return [...runs.values()];
  }

  async #pending(childIds?: readonly string[]): Promise<ChildAgentRunUsage[]> {
    await this.#deps.sessions.discoverNewSessions?.();
    const known = await this.#keys();
    const pending = new Map<string, ChildAgentRunUsage>();
    for (const child of await this.#subtree(childIds)) {
      for (const run of await this.#runs(child.id)) if (!known.has(run.key)) pending.set(run.key, run);
    }
    return [...pending.values()];
  }

  /**
   * Claims, for the turn whose tool received them, the uncounted runs of
   * `childIds` and of their descendants. The tool returns the keys with the
   * usage (ToolResult.subUsageRuns) and the turn metric persists them.
   */
  claimForTurn(childIds: readonly string[]): Promise<ChildAgentClaim> {
    return this.#serial(async () => {
      const runs = await this.#pending(childIds);
      const known = await this.#keys();
      for (const run of runs) known.add(run.key);
      return { usage: sum(runs), keys: runs.map((run) => run.key), runs };
    });
  }

  /**
   * Records every uncounted run of the parent's subtree as standalone usage:
   * background completions, a result whose turn was never written (restart),
   * a descendant that finished after its own parent concluded.
   */
  sweep(): Promise<ChildAgentRunUsage[]> {
    return this.#serial(async () => {
      const runs = await this.#pending();
      const known = await this.#keys();
      for (const run of runs) {
        await this.#deps.recordStandalone(run.usage, run.key);
        known.add(run.key);
      }
      return runs;
    });
  }
}
