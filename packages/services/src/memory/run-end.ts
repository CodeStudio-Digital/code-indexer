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
import type { PipelineProviderResolver, ResolveContext } from '../pipelines/index.js';
import { LlmMemoryDistiller } from './distiller.js';
import { FailureDistiller } from './failure-distiller.js';
import { ProcedureDistiller } from './procedure-distiller.js';
import { MemoryExtractor, type MemoryDedupeSearch, type MemoryDistiller, type MemoryWriter } from './extractor.js';

/**
 * Raw session signal the runner hands over at run-end. Plain data only (no
 * services types) — keeps the code-agent → services boundary structural.
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
}

export interface RunEndMemory {
  extractAndPersist(projectId: number, projectName: string, input: RunEndMemoryInput): Promise<void>;
  /**
   * Whether the `memory_extraction`/`distiller` binding actually resolves —
   * lets the caller skip the (costly) end-of-run summary when no distiller is
   * configured, so an unconfigured project pays nothing.
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
  /** Test seam — inject distillers; defaults to the real LLM-backed trio. */
  distillers?: { positive: MemoryDistiller; failure: MemoryDistiller; procedure: MemoryDistiller };
}

const SOURCE = 'session';
const NOOP_DISTILLER: MemoryDistiller = { async distill() { return []; } };

/** Build the run-end orchestrator. Constructs both distillers once and reuses
 *  the generic extractor (dedup + importance floors + merge) for each. */
export function createRunEndMemory(deps: RunEndMemoryDeps): RunEndMemory {
  const { writer, search, resolver, resolveContext } = deps;
  const positiveDistiller =
    deps.distillers?.positive ?? (resolver ? new LlmMemoryDistiller({ resolver, resolveContext }) : NOOP_DISTILLER);
  const failureDistiller =
    deps.distillers?.failure ?? (resolver ? new FailureDistiller({ resolver, resolveContext }) : NOOP_DISTILLER);
  const procedureDistiller =
    deps.distillers?.procedure ?? (resolver ? new ProcedureDistiller({ resolver, resolveContext }) : NOOP_DISTILLER);
  const positive = new MemoryExtractor(positiveDistiller, writer, search);
  const failure = new MemoryExtractor(failureDistiller, writer, search);
  const procedure = new MemoryExtractor(procedureDistiller, writer, search);

  return {
    async isConfigured() {
      if (!resolver) return false;
      const binding = await resolver
        .resolveOrNull('memory_extraction', 'distiller', resolveContext ?? {})
        .catch(() => null);
      return binding !== null;
    },
    async extractAndPersist(projectId, projectName, input) {
      // Positive durable facts (decisions/conventions/architecture). Only worth
      // an LLM call with some signal.
      if (input.primaryRequest || input.summary) {
        await positive
          .extractAndPersist(projectId, projectName, SOURCE, {
            primaryRequest: input.primaryRequest,
            summary: input.summary,
            filesTouched: input.filesTouched,
          })
          .catch(() => undefined);
      }
      // Failure lessons → `gotcha`. The distiller short-circuits to [] when
      // there are no errors, so guard here to skip even the call.
      if (input.errorsAndFixes?.length) {
        await failure
          .extractAndPersist(projectId, projectName, SOURCE, {
            primaryRequest: input.primaryRequest,
            filesTouched: input.filesTouched,
            errorsAndFixes: input.errorsAndFixes,
          })
          .catch(() => undefined);
      }
      // Procedure recipes — ONLY from runs that succeeded, so the steps come
      // from commands that actually worked (the thesis: verified by tests).
      if (input.succeeded && input.toolTrail?.length) {
        await procedure
          .extractAndPersist(projectId, projectName, SOURCE, {
            primaryRequest: input.primaryRequest,
            summary: input.summary,
            filesTouched: input.filesTouched,
            toolTrail: input.toolTrail,
          })
          .catch(() => undefined);
      }
    },
  };
}
