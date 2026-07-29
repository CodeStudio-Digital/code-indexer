/**
 * Compaction-time memory harvest — feeds the durable project-memory
 * distillers from a summary that was ALREADY paid for (the compaction /
 * "summarize & clear" summarizer), replacing the old per-run-end capture
 * that burned an extra `summarizeSpanV2` LLM call after every run.
 *
 * Also promotes durable session-drive notes (pinned / decision / gotcha /
 * convention / procedure) to project-memory candidates — literal, zero LLM
 * cost — and advances the session's `memory_distilled_message_id` high-water
 * mark so the idle sweeper never re-distills the same span.
 *
 * Best-effort throughout: time-bounded, never throws into the caller.
 */
import type { CompactionSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import { renderSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import type { SessionId } from '@mcp/session-storage';

/** Structural mirror of `RunCoderOptions.runEndMemory` (host callback). */
export interface HarvestRunEndMemory {
  extractAndPersist(
    projectId: number,
    projectName: string,
    input: HarvestInput,
  ): Promise<{ created: number; merged: number; skipped: number; hadError?: boolean } | void>;
  isConfigured(): Promise<boolean>;
}

export interface HarvestInput {
  primaryRequest?: string;
  summary?: string;
  filesTouched?: string[];
  errorsAndFixes?: string[];
  toolTrail?: string[];
  succeeded?: boolean;
  trigger?: string;
  sessionId?: SessionId;
  sessionNotes?: Array<{ title: string; body: string; kind: string; pinned: boolean }>;
}

/** Structural slice of SessionStore used by the harvest. */
export interface HarvestSessionStore {
  getCommandTrail(
    sessionId: SessionId,
    limit?: number,
  ): Promise<Array<{ command: string; isError: boolean }>>;
  didRunSucceed(sessionId: SessionId): Promise<boolean>;
  listSessionMemory(
    sessionId: SessionId,
    opts?: { kind?: string },
  ): Promise<Array<{
    title: string;
    body: string;
    kind: string;
    pinned: boolean;
  }>>;
  setMemoryDistilledBoundary(
    sessionId: SessionId,
    messageSeq: number,
  ): Promise<void>;
}

/** Session-note kinds worth promoting even when not pinned. */
const PROMOTABLE_KINDS = new Set(['decision', 'gotcha', 'convention', 'procedure']);
const MAX_PROMOTED_NOTES = 10;
const HARVEST_TIMEOUT_MS = 30_000;

/**
 * Assemble the distiller input from an already-rendered compaction summary.
 * Pure — unit-testable without a store or LLM.
 */
export function buildHarvestInput(args: {
  summary: CompactionSummaryV2;
  trail: Array<{ command: string; isError: boolean }>;
  succeeded: boolean;
  notes: Array<{ title: string; body: string; kind: string; pinned: boolean }>;
  trigger: string;
  sessionId: SessionId;
}): HarvestInput {
  const { summary, trail, succeeded, notes, trigger, sessionId } = args;
  const sessionNotes = notes
    .filter((n) => n.pinned || PROMOTABLE_KINDS.has(n.kind))
    .slice(0, MAX_PROMOTED_NOTES)
    .map((n) => ({
      title: n.title,
      body: n.body,
      kind: n.kind,
      pinned: n.pinned,
    }));
  return {
    primaryRequest: summary.primary_request || undefined,
    summary: renderSummaryV2(summary),
    filesTouched: summary.files_and_code.map((f) => f.path).filter(Boolean),
    errorsAndFixes: summary.errors_and_fixes,
    // Recipe steps come only from a successful span's clean commands.
    toolTrail: succeeded ? trail.filter((c) => !c.isError).map((c) => c.command) : [],
    succeeded,
    trigger,
    sessionId,
    sessionNotes,
  };
}

/**
 * Fire the distillers over a compaction summary and advance the session's
 * distill high-water mark to the boundary. Time-bounded (30s) and swallowed —
 * a failed harvest costs nothing but the lost learning.
 */
export async function harvestCompactionMemory(args: {
  runEndMemory: HarvestRunEndMemory;
  store: HarvestSessionStore;
  /** Live `projects.memory_enabled` gate (CodeIndexDB read). */
  getMemoryEnabled: () => boolean;
  projectId: number;
  projectName: string;
  sessionId: SessionId;
  summary: CompactionSummaryV2;
  boundaryId: number;
  trigger: 'compaction' | 'manual_clear';
}): Promise<void> {
  const { runEndMemory, store, sessionId } = args;
  try {
    if (!args.getMemoryEnabled()) return;
    if (!(await runEndMemory.isConfigured())) return;

    const [trail, succeeded, notes] = await Promise.all([
      store.getCommandTrail(sessionId),
      store.didRunSucceed(sessionId),
      store.listSessionMemory(sessionId),
    ]);
    const input = buildHarvestInput({
      summary: args.summary,
      trail,
      succeeded,
      notes,
      trigger: args.trigger,
      sessionId,
    });

    const result = await Promise.race([
      runEndMemory.extractAndPersist(args.projectId, args.projectName, input),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, HARVEST_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    // Advance the mark on success and even on TIMEOUT (re-paying the summary
    // to re-distill the same span would only churn the dedup) — but NOT on a
    // real LLM failure: the span stays for the idle sweeper to retry, which
    // caps attempts so a poison span still can't wedge the pipeline.
    if (!(result && result.hadError === true)) {
      await store.setMemoryDistilledBoundary(sessionId, args.boundaryId);
    }
  } catch (e) {
    console.warn(
      `[memory] compaction harvest failed (session ${sessionId}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
