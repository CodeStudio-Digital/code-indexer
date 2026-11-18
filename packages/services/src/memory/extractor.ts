import type { ContextSnapshot, SnapshotCategory } from '@mcp/shared/types.js';

/**
 * Distills durable project memory from a coding session and persists it,
 * deduping against existing memory so the store doesn't bloat.
 *
 * The LLM step is injected as a `MemoryDistiller` so this service is
 * provider-agnostic and unit-testable; the real distiller wraps the
 * PipelineProviderResolver + the memory-extract prompt. The writer/search
 * are structural views of SnapshotService / HybridSearch.
 *
 * Importance floors per category keep high-salience kinds (decisions,
 * conventions) above the injection-worthiness bar even if the LLM
 * under-scores them; near-worthless candidates are dropped.
 */

export interface MemoryCandidate {
  title: string;
  content: string;
  category: SnapshotCategory;
  /** 0..1 salience from the distiller (floored per category). */
  importance: number;
  referencedFiles?: string[];
}

/** Session signal the distiller turns into durable memory candidates. */
export interface SessionMemoryInput {
  primaryRequest?: string;
  decisions?: string[];
  summary?: string;
  filesTouched?: string[];
  /**
   * Current "Project style profile" content (MCP_MEMORY_STYLE_PROFILE fold).
   * `null` = feature ON but no profile yet; `undefined` = feature off. When
   * present, the distiller avoids echoing its known facts and captures only
   * new evidence. Maintenance reconciles compatible facts separately.
   */
  styleProfile?: string | null;
  /**
   * Errors hit and how they were resolved (from the compaction summarizer's
   * `errors_and_fixes`). Included in the unified learning pass as gotchas.
   */
  errorsAndFixes?: string[];
  /**
   * Ordered shell commands that ran successfully this run. Consumed by the
   * unified distiller to mint verified, reusable procedure recipes.
   */
  toolTrail?: string[];
}

export interface MemoryDistiller {
  distill(input: SessionMemoryInput): Promise<MemoryCandidate[]>;
}

export interface MemoryWriter {
  /** Optional durability boundary for one logical extraction pass. */
  runBatch?<T>(operation: () => Promise<T>): Promise<T>;
  create(
    projectId: number,
    data: {
      title: string;
      category: SnapshotCategory;
      content: string;
      source: string;
      importance: number;
      referencedFiles?: string[];
    },
  ): Promise<unknown>;
  update(
    id: number,
    updates: { content?: string; projectId?: number; importance?: number; referencedFiles?: string[] },
  ): Promise<unknown>;
}

export interface MemoryDedupeSearch {
  searchSnapshotsHybrid(
    projectId: number,
    projectName: string,
    query: string,
    limit: number,
  ): Promise<ContextSnapshot[]>;
}

export interface ExtractResult {
  created: number;
  merged: number;
  skipped: number;
}

const IMPORTANCE_FLOOR: Partial<Record<SnapshotCategory, number>> = {
  feedback: 0.75,
  user: 0.7,
  decision: 0.7,
  procedure: 0.7,
  gotcha: 0.65,
  convention: 0.6,
  architecture: 0.6,
  pattern: 0.5,
  todo: 0.4,
  note: 0.3,
};

export class MemoryExtractor {
  constructor(
    private readonly distiller: MemoryDistiller,
    private readonly writer: MemoryWriter,
    private readonly search: MemoryDedupeSearch,
  ) {}

  async extractAndPersist(
    projectId: number,
    projectName: string,
    source: string,
    input: SessionMemoryInput,
  ): Promise<ExtractResult> {
    const out: ExtractResult = { created: 0, merged: 0, skipped: 0 };

    // The orchestrator isolates failures from the chat, but must keep the input
    // retryable. Returning an empty success here would consume an unsaved lesson.
    const candidates = await this.distiller.distill(input);

    const persist = async (): Promise<ExtractResult> => {
      for (const c of candidates) {
        // Automatic salience is not a user pin; repetition is not new evidence.
        const importance = Math.min(0.85, Math.max(c.importance ?? 0.5, IMPORTANCE_FLOOR[c.category] ?? 0));
        if (!c.title.trim() || !c.content.trim()) {
          out.skipped++;
          continue;
        }

        const existing = await this.search
          .searchSnapshotsHybrid(projectId, projectName, `${c.title}\n${c.content}`.slice(0, 500), 3)
          .catch(() => [] as ContextSnapshot[]);
        const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
        const dup = existing.find((s) =>
          (s.category === c.category || (['user', 'feedback'].includes(s.category) && ['user', 'feedback'].includes(c.category)))
          && normalized(s.content) === normalized(c.content));

        if (dup) {
          // Preserve provenance and historical file baselines on repeated text.
          // Related but different facts stay separate for evidence-based review.
          out.skipped++;
        } else {
          await this.writer.create(projectId, {
            title: c.title.trim(),
            category: c.category,
            content: c.content.trim(),
            source,
            importance,
            referencedFiles: c.referencedFiles,
          });
          out.created++;
        }
      }
      return out;
    };
    return this.writer.runBatch ? this.writer.runBatch(persist) : persist();
  }
}
