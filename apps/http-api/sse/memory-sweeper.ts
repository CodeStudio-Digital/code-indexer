/**
 * Idle memory sweeper — the "session went quiet" distill moment.
 *
 * The compaction harvest only learns when a session compacts; short sessions
 * (most of them) never do. This sweeper wakes every `intervalMs`, finds
 * sessions that have been idle for `idleAfterMs` with messages past their
 * `memory_distilled_message_id` mark, summarizes ONLY that span and feeds the
 * same distill pipeline (positive + gotcha + procedure + note promotion).
 *
 * Runs in the MAIN process (mirrors `coder-watchdog.ts`): worker timers die
 * with the worker pool, while the mark is a DB column — so the sweep survives
 * restarts and covers "user closed the app" for free.
 *
 * Failure semantics (migration 185): a FAILED pass (LLM error, timeout) keeps
 * the mark intact and bumps `memory_distill_attempts` — the span is retried
 * with linear backoff. Anti poison-pill lives in the RETRY CAP instead: after
 * `MAX_DISTILL_ATTEMPTS` failures the mark advances anyway (`retry_cap` in
 * the log) so one broken session can't wedge every sweep forever.
 */
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { summarizeSpanV2 } from '@mcp/code-agent/core/summarizer.js';
import { buildHarvestInput } from '@mcp/code-agent/core/runner/compaction/memory-harvest.js';
import type { RunEndMemory } from '@mcp/services/memory/run-end.js';
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';

const DEFAULT_INTERVAL_MS = Number(process.env.MCP_MEMORY_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000);
const DEFAULT_IDLE_AFTER_MS = Number(process.env.MCP_MEMORY_IDLE_AFTER_MS ?? 10 * 60 * 1000);
const DEFAULT_MAX_PER_SWEEP = Number(process.env.MCP_MEMORY_SWEEP_MAX_SESSIONS ?? 2);
/** Spans shorter than this aren't worth an LLM pass — mark them covered. */
const MIN_SPAN_MESSAGES = 4;
const STEP_TIMEOUT_MS = 60_000;
/** Give up on a span after this many failed passes (poison-pill guard). */
const MAX_DISTILL_ATTEMPTS = 3;

export function memorySweeperEnabled(): boolean {
  const raw = process.env.MCP_MEMORY_SWEEPER;
  if (raw == null || raw === '') return true;
  const v = raw.toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

export interface MemorySweeperHandle {
  stop(): void;
  /** One-shot sweep for tests; returns sessions distilled this pass. */
  runOnce(): Promise<number>;
  readonly intervalMs: number;
  readonly idleAfterMs: number;
}

export interface StartMemorySweeperArgs {
  sessionStore: SessionStore;
  db: CodeIndexDB;
  runEndMemory: RunEndMemory;
  agentMemoryService?: AgentMemoryService;
  intervalMs?: number;
  idleAfterMs?: number;
  maxPerSweep?: number;
  /** Test seam — replaces the real provider factory. */
  providerFactory?: typeof createCoderProvider;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), ms);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

export function startMemorySweeper(args: StartMemorySweeperArgs): MemorySweeperHandle {
  const intervalMs = args.intervalMs ?? DEFAULT_INTERVAL_MS;
  const idleAfterMs = args.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const maxPerSweep = args.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
  const makeProvider = args.providerFactory ?? createCoderProvider;
  const { sessionStore, db, runEndMemory, agentMemoryService } = args;

  let stopped = false;
  let inFlight = false;

  /** Advance the mark and clear the failure streak — the span is settled. */
  const settleSpan = (sessionId: number, maxId: number): void => {
    try {
      sessionStore.setMemoryDistilledBoundary(sessionId, maxId);
      sessionStore.resetMemoryDistillAttempts(sessionId);
    } catch { /* best-effort */ }
  };
  /** Record one more failed pass — mark stays put so the span retries. */
  const recordFailure = (
    cand: { session_id: number; project_id: number }, detail: string, msg: string,
  ): void => {
    try { sessionStore.bumpMemoryDistillAttempts(cand.session_id); } catch { /* best-effort */ }
    try {
      db.insertMemoryDistillLog(cand.project_id, {
        sessionId: cand.session_id, trigger: 'idle', status: 'error', detail, error: msg,
      });
    } catch { /* diagnostics are best-effort */ }
  };

  const sweepSession = async (cand: {
    session_id: number; project_id: number; provider: string; model: string;
    distilled_mark: number; attempts: number;
  }): Promise<boolean> => {
    const span = sessionStore.listMessagesAfter(cand.session_id, cand.distilled_mark);
    if (span.messages.length === 0) return false;
    if (cand.attempts >= MAX_DISTILL_ATTEMPTS) {
      // Poison-pill guard: give up on this span so it can't wedge every sweep.
      settleSpan(cand.session_id, span.maxId);
      try {
        db.insertMemoryDistillLog(cand.project_id, {
          sessionId: cand.session_id, trigger: 'idle', status: 'skipped', detail: 'retry_cap',
          error: `gave up after ${cand.attempts} failed distill attempts`,
        });
      } catch { /* diagnostics are best-effort */ }
      return false;
    }
    if (span.messages.length < MIN_SPAN_MESSAGES) {
      // Not worth an LLM pass — mark covered so the candidate stops resurfacing.
      settleSpan(cand.session_id, span.maxId);
      return false;
    }

    try {
      const provider = await makeProvider(cand.provider, cand.model);
      const summary = await withTimeout(summarizeSpanV2(span.messages, provider), STEP_TIMEOUT_MS);
      if (!summary) {
        recordFailure(cand, 'summarizer_timeout', 'summarizer returned no result');
        return false;
      }
      const input = buildHarvestInput({
        summary,
        trail: sessionStore.getCommandTrail(cand.session_id),
        succeeded: sessionStore.didRunSucceed(cand.session_id),
        notes: sessionStore.listSessionMemory(cand.session_id),
        trigger: 'idle',
        sessionId: cand.session_id,
      });
      const projectName = db.getProject(cand.project_id)?.name ?? '';
      // extractAndPersist writes its own memory_distill_log entry.
      const result = await withTimeout(
        Promise.resolve(runEndMemory.extractAndPersist(cand.project_id, projectName, input)),
        STEP_TIMEOUT_MS,
      );
      if (result === undefined) {
        // Timed out mid-extract — run-end never logged; the span retries.
        recordFailure(cand, 'extract_timeout', `extract exceeded ${STEP_TIMEOUT_MS}ms`);
        return false;
      }
      if (result && result.hadError) {
        // run-end already logged the error row with its diag — just keep the span.
        try { sessionStore.bumpMemoryDistillAttempts(cand.session_id); } catch { /* best-effort */ }
        return false;
      }
      settleSpan(cand.session_id, span.maxId);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[memory/sweeper] session ${cand.session_id} failed: ${msg}`);
      recordFailure(cand, 'sweep_error', msg);
      return false;
    }
  };

  const runOnce = async (): Promise<number> => {
    if (stopped || inFlight) return 0;
    inFlight = true;
    try {
      const candidates = sessionStore.listMemoryDistillPending(
        Math.floor(idleAfterMs / 1000), maxPerSweep,
      );
      if (candidates.length === 0) return 0;
      if (!(await runEndMemory.isConfigured())) return 0; // logs its own skip reason
      let distilled = 0;
      for (const cand of candidates) {
        if (stopped) break;
        if (await sweepSession(cand)) distilled++;
      }
      if (distilled > 0) {
        console.log(`[memory/sweeper] swept — distilled=${distilled}/${candidates.length} idle session(s)`);
      }
      // WS8 — background hygiene: collapse exact-duplicate memories (a safety net
      // on top of write-time dedup) for the projects touched this sweep + the
      // user scope, and prune the telemetry events table (retention). All
      // deterministic + best-effort; never wedges a sweep.
      try {
        const projects = new Set(candidates.map((c) => c.project_id));
        let archived = 0;
        let decayed = 0;
        for (const pid of projects) {
          const result = agentMemoryService?.runScopeMutation('project', pid, () => ({
            consolidated: db.consolidateAgentMemory('project', pid).archived,
            // Reversible decay of cold, never-accessed, low-importance `note`s
            // (>60d) — project scope only; user-scope preferences never decay.
            decayed: db.decayColdAgentMemoryNotes('project', pid),
          })) ?? {
            consolidated: db.consolidateAgentMemory('project', pid).archived,
            decayed: db.decayColdAgentMemoryNotes('project', pid),
          };
          const consolidated = result.consolidated;
          archived += consolidated;
          const projectDecayed = result.decayed;
          decayed += projectDecayed;
        }
        const userArchived = agentMemoryService?.runScopeMutation(
          'user',
          0,
          () => db.consolidateAgentMemory('user', 0).archived,
        ) ?? db.consolidateAgentMemory('user', 0).archived;
        archived += userArchived;
        const prunedEvents = db.pruneAgentMemoryEvents();
        if (archived > 0 || decayed > 0 || prunedEvents > 0) {
          console.log(`[memory/sweeper] hygiene — archived=${archived} dup memories, decayed=${decayed} cold notes, pruned=${prunedEvents} events`);
        }
      } catch (e) {
        console.warn(`[memory/sweeper] hygiene failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return distilled;
    } catch (e) {
      console.warn(`[memory/sweeper] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[memory/sweeper] started — interval=${Math.round(intervalMs / 1000)}s ` +
    `idleAfter=${Math.round(idleAfterMs / 1000)}s maxPerSweep=${maxPerSweep}`,
  );

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      console.log('[memory/sweeper] stopped');
    },
    runOnce,
    intervalMs,
    idleAfterMs,
  };
}
