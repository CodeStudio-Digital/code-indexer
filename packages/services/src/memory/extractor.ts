import type { ContextSnapshot, SnapshotCategory } from '@mcp/shared/types.js';
import { titleSimilarity } from './text-sim.js';

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
   * Errors hit and how they were resolved (from the compaction summarizer's
   * `errors_and_fixes`). Consumed by the failure distiller to mint `gotcha`
   * lessons; the positive distiller ignores it.
   */
  errorsAndFixes?: string[];
  /**
   * Ordered shell commands that ran successfully this run. Consumed by the
   * procedure distiller to mint `procedure` recipes; other distillers ignore it.
   */
  toolTrail?: string[];
}

export interface MemoryDistiller {
  distill(input: SessionMemoryInput): Promise<MemoryCandidate[]>;
}

export interface MemoryWriter {
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
    updates: { content?: string; projectId?: number; importance?: number },
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
const DUP_TITLE_THRESHOLD = 0.6;

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

    let candidates: MemoryCandidate[];
    try {
      candidates = await this.distiller.distill(input);
    } catch {
      return out; // distillation is best-effort — never break the session over it
    }

    for (const c of candidates) {
      const importance = Math.max(c.importance ?? 0.5, IMPORTANCE_FLOOR[c.category] ?? 0);
      if (!c.title.trim() || !c.content.trim()) {
        out.skipped++;
        continue;
      }

      const existing = await this.search
        .searchSnapshotsHybrid(projectId, projectName, `${c.title}\n${c.content}`.slice(0, 500), 3)
        .catch(() => [] as ContextSnapshot[]);
      const dup = existing.find(
        (s) => s.category === c.category && titleSimilarity(s.title, c.title) >= DUP_TITLE_THRESHOLD,
      );

      if (dup) {
        // Merge: enrich the existing memory rather than spawning a near-dup.
        // Corroboration bumps importance slightly (capped at 1) so a fact the
        // session keeps re-deriving rises above the injection bar. When the
        // body doesn't actually grow, the importance-only update stays on the
        // cheap metadata path (no version row, no embedding invalidation).
        const merged = dup.content.includes(c.content.trim())
          ? dup.content
          : `${dup.content}\n\n${c.content.trim()}`;
        const importanceBump = Math.min(1, (dup.importance ?? 0.5) + 0.02);
        await this.writer.update(dup.id, {
          ...(merged !== dup.content ? { content: merged } : {}),
          projectId,
          importance: importanceBump,
        });
        out.merged++;
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
  }
}
