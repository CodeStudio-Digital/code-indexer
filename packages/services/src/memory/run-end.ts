/**
 * End-of-run memory orchestrator — distills DURABLE project memory off the hot
 * path after a coder run finishes, activating the previously-dormant
 * {@link MemoryExtractor} pipeline and adding failure capture (`gotcha`).
 *
 * Wired host-side (http-api `deps.ts`) from the already-constructed
 * SnapshotService (writer), HybridSearch (dedup) and PipelineProviderResolver
 * (LLM binding), then passed into `runCoder` as the structural `runEndMemory`
 * callback — so code-agent stays decoupled from services (mirrors
 * `memoryRetriever`). The runner assembles the raw signal (via its own
 * summarizer) and calls this; everything here is best-effort and swallows its
 * own errors so a failed distillation can never affect the user's session.
 */
import type { FallbackDefault, PipelineProviderResolver, ResolveContext } from '../pipelines/index.js';
import { LlmMemoryDistiller } from './distiller.js';
import { FailureDistiller } from './failure-distiller.js';
import { ProcedureDistiller } from './procedure-distiller.js';
import {
  MemoryExtractor,
  type MemoryCandidate,
  type MemoryDedupeSearch,
  type MemoryDistiller,
  type MemoryWriter,
} from './extractor.js';

/**
 * Raw session signal the runner hands over at a distill moment. Plain data
 * only (no services types) — keeps the code-agent → services boundary
 * structural.
 */
export interface RunEndMemoryInput {
  primaryRequest?: string;
  /** Rendered session summary (the distiller's main signal for durable facts). */
  summary?: string;
  filesTouched?: string[];
  /** `errors_and_fixes` from the summarizer — the failure-lesson source. */
  errorsAndFixes?: string[];
  /** Shell commands that ran successfully — the procedure-recipe source. */
  toolTrail?: string[];
  /** Whether the run reached a clean terminal state. Gates recipe distillation
   *  (recipes are only minted from runs that demonstrably succeeded). */
  succeeded?: boolean;
  /** Which moment produced the signal — recorded in the distill log
   *  (compaction | manual_clear | idle | …). */
  trigger?: string;
  /** Session that produced the signal — recorded in the distill log. */
  sessionId?: number;
  /** Session-drive notes promoted to project-memory candidates. Literal
   *  (no LLM cost) — they go through the same dedup/merge as distilled
   *  candidates. Caller pre-filters to pinned / durable kinds. */
  sessionNotes?: Array<{ title: string; body: string; kind: string; pinned: boolean }>;
}

/** Aggregate write counts of one distillation pass (sum of all extractors). */
export interface RunEndMemoryResult {
  created: number;
  merged: number;
  skipped: number;
}

export interface RunEndMemory {
  extractAndPersist(
    projectId: number,
    projectName: string,
    input: RunEndMemoryInput,
  ): Promise<RunEndMemoryResult | void>;
  /**
   * Whether a distiller model resolves — binding row or the zero-config
   * general-default fallback. Lets the caller skip the (costly) summary
   * when nothing could distill, so an unconfigurable install pays nothing.
   */
  isConfigured(): Promise<boolean>;
}

export interface RunEndMemoryDeps {
  writer: MemoryWriter;
  search: MemoryDedupeSearch;
  /** LLM binding for the real distillers. Optional only so tests can inject
   *  `distillers` instead; production always provides it. */
  resolver?: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Zero-config fallback (general default model) consulted when the
   *  `memory_extraction`/`distiller` binding doesn't resolve — makes memory
   *  work out-of-the-box; the binding remains an optional override. Lazy
   *  because the operator can change the setting at runtime. */
  getFallbackDefault?: () => FallbackDefault | null;
  /** Diagnostics sink — one entry per distillation pass (memory_distill_log).
   *  Best-effort: a sink failure never affects the pass. */
  distillLog?: (
    projectId: number,
    entry: {
      sessionId?: number | null;
      trigger: string;
      status: 'ok' | 'empty' | 'error';
      created: number;
      merged: number;
      skipped: number;
      error?: string | null;
    },
  ) => void;
  /** Test seam — inject distillers; defaults to the real LLM-backed trio. */
  distillers?: { positive: MemoryDistiller; failure: MemoryDistiller; procedure: MemoryDistiller };
}

const SOURCE = 'session';
const NOOP_DISTILLER: MemoryDistiller = { async distill() { return []; } };

/** Build the run-end orchestrator. Constructs both distillers once and reuses
 *  the generic extractor (dedup + importance floors + merge) for each. */
export function createRunEndMemory(deps: RunEndMemoryDeps): RunEndMemory {
  const { writer, search, resolver, resolveContext, getFallbackDefault } = deps;
  const positiveDistiller =
    deps.distillers?.positive ??
    (resolver ? new LlmMemoryDistiller({ resolver, resolveContext, getFallbackDefault }) : NOOP_DISTILLER);
  const failureDistiller =
    deps.distillers?.failure ??
    (resolver ? new FailureDistiller({ resolver, resolveContext, getFallbackDefault }) : NOOP_DISTILLER);
  const procedureDistiller =
    deps.distillers?.procedure ??
    (resolver ? new ProcedureDistiller({ resolver, resolveContext, getFallbackDefault }) : NOOP_DISTILLER);
  const positive = new MemoryExtractor(positiveDistiller, writer, search);
  const failure = new MemoryExtractor(failureDistiller, writer, search);
  const procedure = new MemoryExtractor(procedureDistiller, writer, search);

  // Never-silent posture: log the resolved state once per distinct outcome
  // (binding vs fallback vs nothing) instead of every run-end.
  let lastLoggedState: string | null = null;
  const logStateOnce = (state: string, line: string, warn = false): void => {
    if (state === lastLoggedState) return;
    lastLoggedState = state;
    if (warn) console.warn(line);
    else console.log(line);
  };

  return {
    async isConfigured() {
      if (!resolver) return false;
      const binding = await resolver
        .resolveOrNull('memory_extraction', 'distiller', resolveContext ?? {}, getFallbackDefault?.() ?? undefined)
        .catch(() => null);
      if (!binding) {
        logStateOnce(
          'unconfigured',
          '[memory] distillation skipped: no memory_extraction/distiller binding and no general default model',
          true,
        );
        return false;
      }
      logStateOnce(
        `${binding.resolvedFrom}:${binding.modelId}`,
        `[memory] distiller resolved from=${binding.resolvedFrom} model=${binding.modelId}`,
      );
      return true;
    },
    async extractAndPersist(projectId, projectName, input) {
      const totals = { created: 0, merged: 0, skipped: 0 };
      let lastError: string | null = null;
      const add = (r: { created: number; merged: number; skipped: number } | undefined): void => {
        if (!r) return;
        totals.created += r.created;
        totals.merged += r.merged;
        totals.skipped += r.skipped;
      };
      const swallow = (e: unknown): undefined => {
        lastError = e instanceof Error ? e.message : String(e);
        return undefined;
      };

      // Positive durable facts (decisions/conventions/architecture). Only worth
      // an LLM call with some signal.
      if (input.primaryRequest || input.summary) {
        add(await positive
          .extractAndPersist(projectId, projectName, SOURCE, {
            primaryRequest: input.primaryRequest,
            summary: input.summary,
            filesTouched: input.filesTouched,
          })
          .catch(swallow));
      }
      // Failure lessons → `gotcha`. The distiller short-circuits to [] when
      // there are no errors, so guard here to skip even the call.
      if (input.errorsAndFixes?.length) {
        add(await failure
          .extractAndPersist(projectId, projectName, SOURCE, {
            primaryRequest: input.primaryRequest,
            filesTouched: input.filesTouched,
            errorsAndFixes: input.errorsAndFixes,
          })
          .catch(swallow));
      }
      // Procedure recipes — ONLY from runs that succeeded, so the steps come
      // from commands that actually worked (the thesis: verified by tests).
      if (input.succeeded && input.toolTrail?.length) {
        add(await procedure
          .extractAndPersist(projectId, projectName, SOURCE, {
            primaryRequest: input.primaryRequest,
            summary: input.summary,
            filesTouched: input.filesTouched,
            toolTrail: input.toolTrail,
          })
          .catch(swallow));
      }
      // Session→project promotion — pinned / durable-kind session notes become
      // LITERAL candidates (zero LLM cost) and ride the same dedup/merge as
      // distilled memory, so re-promotion on later passes is a no-op.
      const noteCandidates = (input.sessionNotes ?? [])
        .slice(0, 10)
        .map(promotedNoteToCandidate)
        .filter((c): c is NonNullable<typeof c> => c !== null);
      if (noteCandidates.length) {
        const literal = new MemoryExtractor({ distill: async () => noteCandidates }, writer, search);
        add(await literal.extractAndPersist(projectId, projectName, 'session', {}).catch(swallow));
      }

      try {
        deps.distillLog?.(projectId, {
          sessionId: input.sessionId ?? null,
          trigger: input.trigger ?? 'run',
          status: lastError ? 'error' : totals.created + totals.merged + totals.skipped === 0 ? 'empty' : 'ok',
          ...totals,
          error: lastError,
        });
      } catch {
        /* diagnostics must never affect the pass */
      }
      return totals;
    },
  };
}

/** Session-note kind → durable memory category for promotion. */
const NOTE_KIND_TO_CATEGORY: Record<string, MemoryCandidate['category']> = {
  decision: 'decision',
  gotcha: 'gotcha',
  convention: 'convention',
  procedure: 'procedure',
  risk: 'gotcha',
  fact: 'note',
  todo: 'todo',
};

function promotedNoteToCandidate(
  note: { title: string; body: string; kind: string; pinned: boolean },
): MemoryCandidate | null {
  const title = note.title?.trim();
  const content = note.body?.trim();
  if (!title || !content) return null;
  const category = NOTE_KIND_TO_CATEGORY[note.kind] ?? (note.pinned ? 'note' : null);
  if (!category) return null;
  // Pinned notes carry explicit user/agent intent — small salience boost; the
  // extractor still applies the per-category floor on top.
  return { title, content, category, importance: note.pinned ? 0.75 : 0.55 };
}
