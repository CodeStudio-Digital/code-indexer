/**
 * The single-shot indexer-adapter contract.
 *
 * Used by the codebase indexer to extract structured metadata from a file in
 * one call (no streaming, no tools). Historically defined in
 * `@mcp/indexer/indexer/providers/base.ts`; moved here so the SDK owns the
 * contract. The old module re-exports `LLMProvider`.
 */
import type { AnalysisResult } from '@mcp/shared/types.js';

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Optional cheap model identifier for summary-only analysis. When set,
   * `analyzeSummary` should call this model instead of `model`. Falls through
   * to `model` when undefined.
   */
  readonly summaryModel?: string;
  analyzeFile(filePath: string, content: string): Promise<AnalysisResult>;
  /**
   * Summary-only analysis — used when tree-sitter handles structural extraction.
   * Sends a skeleton instead of full content, requesting only semantic metadata.
   * Default implementation falls back to full analyzeFile().
   */
  analyzeSummary?(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; kind: string; signature: string; line?: number | null; end_line?: number }>,
  ): Promise<AnalysisResult>;
}
