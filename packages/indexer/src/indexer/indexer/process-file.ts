import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type {
  AnalysisResult,
  LLMFileAnalysis,
  ScannedFile,
} from '@mcp/shared/types.js';
import type { TreeSitterResult } from '@mcp/indexer/indexer/tree-sitter/index.js';
import { safeJsonArray } from '@mcp/shared/utils/safe-json.js';

import { cosineSimilarity } from './cosine.js';
import { enrichReferencesWithLines } from './enrich-references.js';

export interface ProcessFileDeps {
  db: CodeIndexDB;
  provider: LLMProvider;
  embeddingService: EmbeddingService;
  costTracker: CostTracker;
}

export interface ProcessFileResult {
  fileId: number;
  analysis: LLMFileAnalysis;
  content: string;
  treeSitterHit: boolean;
  llmSkipped: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Per-file pipeline inside `indexProject`. Runs tree-sitter extraction, falls
 * back to / augments with LLM analysis, persists everything (file, symbols,
 * dependencies, references, file snapshot). Returns the LLM tokens used so
 * the caller can aggregate.
 *
 * Logic:
 *   1. Tree-sitter extracts symbols. When unsupported → full LLM analysis.
 *   2. When supported, hash the structure. If unchanged + we already have a
 *      summary in DB, REUSE the LLM metadata (skip the LLM call entirely).
 *   3. If structure changed: pick the cheaper LLM call when similarity is
 *      high (`analyzeSummary`), full content analysis otherwise.
 *   4. Persist file/symbols/deps/references/snapshot.
 */
export async function processFile(
  deps: ProcessFileDeps,
  project: { id: number },
  runId: number,
  file: ScannedFile & { tier?: 'core' | 'support' | 'on_demand'; mapperReason?: string },
  treeSitter: { extract: (filePath: string, content: string) => Promise<TreeSitterResult> },
): Promise<ProcessFileResult> {
  let content = file.content;
  if (!content && file.path) {
    const { readFileSync } = await import('node:fs');
    content = readFileSync(file.path, 'utf-8');
  }

  const tsResult = await treeSitter.extract(file.relativePath, content);
  let result: AnalysisResult;
  let treeSitterHit = false;
  let llmSkipped = false;

  if (tsResult.supported && tsResult.analysis.symbols && tsResult.analysis.symbols.length > 0) {
    treeSitterHit = true;
    ({ result, llmSkipped } = await analyzeWithTreeSitter(deps, project, file, content, tsResult));
  } else {
    // Unsupported language — full LLM analysis as before.
    result = await deps.provider.analyzeFile(file.relativePath, content);
  }

  const cost = deps.costTracker.record({
    projectId: project.id,
    runId,
    provider: deps.provider.name,
    model: deps.provider.model,
    operation: 'analysis',
    filePath: file.relativePath,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });

  // The whole composite persist (file row, structure hash, symbols, deps,
  // references, snapshot) commits as ONE transaction. The block is fully
  // synchronous; the individual upserts' inner transactions become
  // savepoints. Before this, a crash between upsertFile and upsertSymbols
  // left a fresh file row pointing at stale symbols.
  const fileId = deps.db.transaction(() => {
    const id = deps.db.upsertFile(project.id, {
      path: file.relativePath,
      language: result.analysis.language,
      size: file.sizeBytes,
      lineCount: file.lineCount,
      contentHash: file.hash,
      summary: result.analysis.summary,
      concepts: result.analysis.concepts,
      dependencies: result.analysis.dependencies,
      internalDeps: result.analysis.internal_deps,
      externalDeps: result.analysis.external_deps,
      notes: result.analysis.notes,
      complexity: result.analysis.complexity,
      layer: result.analysis.layer,
      isEntryPoint: result.analysis.is_entry_point,
      isTest: result.analysis.is_test,
      isGenerated: result.analysis.is_generated,
      indexTier: file.tier,
      mapperReason: file.mapperReason,
    });

    // Persist structure hash + embedding when tree-sitter produced them.
    const stash = tsResult as { _structHash?: string; _structEmbedding?: Float32Array };
    if (tsResult.supported && stash._structHash) deps.db.setFileStructureHash(id, stash._structHash);
    if (tsResult.supported && stash._structEmbedding) deps.db.setFileStructureEmbedding(id, stash._structEmbedding);

    deps.db.upsertSymbols(project.id, id, file.relativePath, result.analysis.symbols);
    deps.db.upsertFileDependencies(project.id, id, file.relativePath, result.analysis.internal_deps, result.analysis.external_deps);

    if (result.analysis.references && result.analysis.references.length > 0) {
      const enriched = enrichReferencesWithLines(result.analysis.references, content);
      deps.db.upsertSymbolReferences(project.id, id, file.relativePath, enriched);
    }

    deps.db.saveFileSnapshot({
      runId, projectId: project.id, filePath: file.relativePath, contentHash: file.hash,
      summary: result.analysis.summary, concepts: result.analysis.concepts, symbols: result.analysis.symbols,
    });
    return id;
  });

  return {
    fileId,
    analysis: result.analysis,
    content,
    treeSitterHit,
    llmSkipped,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: cost,
  };
}

async function analyzeWithTreeSitter(
  deps: ProcessFileDeps,
  project: { id: number },
  file: ScannedFile,
  content: string,
  tsResult: TreeSitterResult,
): Promise<{ result: AnalysisResult; llmSkipped: boolean }> {
  const structSig = tsResult.analysis.symbols!.map((s) => `${s.kind}:${s.name}:${s.signature}`).sort().join('|');
  const newStructHash = createHash('md5').update(structSig).digest('hex');

  const oldStructHash = deps.db.getFileStructureHash(project.id, file.relativePath);
  const existingFile = deps.db.getFile(project.id, file.relativePath);
  const oldStructEmbedding = deps.db.getFileStructureEmbedding(project.id, file.relativePath);

  let sim = 0;
  let newStructEmbedding: Float32Array | null = null;

  if (oldStructHash === newStructHash && existingFile && existingFile.summary) {
    sim = 1.0;
  } else if (oldStructEmbedding && existingFile && existingFile.summary) {
    const { vector } = await deps.embeddingService.embedQuery(structSig);
    if (vector && vector.length > 0) {
      newStructEmbedding = new Float32Array(vector);
      sim = cosineSimilarity(oldStructEmbedding, newStructEmbedding);
    }
  }

  let result: AnalysisResult;
  let llmSkipped = false;

  if (sim >= 0.98 && existingFile && existingFile.summary) {
    // Structure unchanged (or trivially changed) — reuse existing LLM metadata.
    llmSkipped = true;
    result = {
      analysis: {
        language: tsResult.analysis.language ?? existingFile.language,
        summary: existingFile.summary,
        concepts: safeJsonArray<string>(existingFile.concepts),
        dependencies: tsResult.analysis.dependencies ?? safeJsonArray<string>(existingFile.dependencies),
        internal_deps: tsResult.analysis.internal_deps ?? safeJsonArray<string>(existingFile.internal_deps),
        external_deps: tsResult.analysis.external_deps ?? safeJsonArray<string>(existingFile.external_deps),
        notes: safeJsonArray<string>(existingFile.notes),
        complexity: existingFile.complexity,
        layer: existingFile.layer,
        is_entry_point: !!existingFile.is_entry_point,
        is_test: !!existingFile.is_test,
        is_generated: !!existingFile.is_generated,
        symbols: tsResult.analysis.symbols!,
        references: tsResult.analysis.references ?? [],
      },
      inputTokens: 0,
      outputTokens: 0,
    };
  } else {
    // Structure changed — call LLM. Use the cheaper summary prompt for moderate
    // changes (sim >= 0.90), fall back to full content analysis otherwise.
    const llmResult = sim >= 0.90 && deps.provider.analyzeSummary
      ? await deps.provider.analyzeSummary(file.relativePath, content, tsResult.analysis.symbols!)
      : await deps.provider.analyzeFile(file.relativePath, content);
    result = {
      analysis: {
        ...llmResult.analysis,
        symbols: tsResult.analysis.symbols!,
        references: tsResult.analysis.references ?? llmResult.analysis.references ?? [],
        dependencies: tsResult.analysis.dependencies ?? llmResult.analysis.dependencies,
        internal_deps: tsResult.analysis.internal_deps ?? llmResult.analysis.internal_deps,
        external_deps: tsResult.analysis.external_deps ?? llmResult.analysis.external_deps,
        language: tsResult.analysis.language ?? llmResult.analysis.language,
      },
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
    };
  }

  // Compute structure embedding when similarity branch didn't need it yet.
  if (!newStructEmbedding && sim !== 1.0) {
    const { vector } = await deps.embeddingService.embedQuery(structSig);
    if (vector && vector.length > 0) newStructEmbedding = new Float32Array(vector);
  }

  // Stash on the tree-sitter result so the caller can persist after upsertFile.
  (tsResult as { _structHash?: string })._structHash = newStructHash;
  (tsResult as { _structEmbedding?: Float32Array })._structEmbedding = newStructEmbedding ?? undefined;

  return { result, llmSkipped };
}
