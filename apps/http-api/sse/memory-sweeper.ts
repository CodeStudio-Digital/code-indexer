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
 * restarts and covers "user closed the app" for free. Anti poison-pill: the
 * mark advances even when a candidate errors (the failure is recorded in
 * `memory_distill_log`, visible in the project's memory-health card).
 */
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { summarizeSpanV2 } from '@mcp/code-agent/core/summarizer.js';
import { buildHarvestInput } from '@mcp/code-agent/core/runner/compaction/memory-harvest.js';
import type { RunEndMemory } from '@mcp/services/memory/run-end.js';
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';

const DEFAULT_INTERVAL_MS = Number(process.env.MCP_MEMORY_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000);
const DEFAULT_IDLE_AFTER_MS = Number(process.env.MCP_MEMORY_IDLE_AFTER_MS ?? 10 * 60 * 1000);
const DEFAULT_MAX_PER_SWEEP = Number(process.env.MCP_MEMORY_SWEEP_MAX_SESSIONS ?? 2);
/** Spans shorter than this aren't worth an LLM pass — mark them covered. */
const MIN_SPAN_MESSAGES = 4;
const STEP_TIMEOUT_MS = 60_000;

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
  const { sessionStore, db, runEndMemory } = args;

  let stopped = false;
  let inFlight = false;

  const sweepSession = async (cand: {
    session_id: number; project_id: number; provider: string; model: string; distilled_mark: number;
  }): Promise<boolean> => {
    const span = sessionStore.listMessagesAfter(cand.session_id, cand.distilled_mark);
    if (span.messages.length === 0) return false;
    if (span.messages.length < MIN_SPAN_MESSAGES) {
      // Not worth an LLM pass — mark covered so the candidate stops resurfacing.
      sessionStore.setMemoryDistilledBoundary(cand.session_id, span.maxId);
      return false;
    }

    try {
      const provider = await makeProvider(cand.provider, cand.model);
      const summary = await withTimeout(summarizeSpanV2(span.messages, provider), STEP_TIMEOUT_MS);
      if (!summary) {
        db.insertMemoryDistillLog(cand.project_id, {
          sessionId: cand.session_id, trigger: 'idle', status: 'empty',
          error: 'summarizer returned no result',
        });
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
      await withTimeout(
        Promise.resolve(runEndMemory.extractAndPersist(cand.project_id, projectName, input)),
        STEP_TIMEOUT_MS,
      );
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[memory/sweeper] session ${cand.session_id} failed: ${msg}`);
      try {
        db.insertMemoryDistillLog(cand.project_id, {
          sessionId: cand.session_id, trigger: 'idle', status: 'error', error: msg,
        });
      } catch { /* diagnostics are best-effort */ }
      return false;
    } finally {
      // Advance even on error — a poison session must not wedge every sweep.
      try { sessionStore.setMemoryDistilledBoundary(cand.session_id, span.maxId); } catch { /* best-effort */ }
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
