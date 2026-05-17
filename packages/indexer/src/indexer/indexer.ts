import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type {
  IndexResult,
  IndexProgress,
  ProgressCallback,
  VectorRecord,
  ScannedFile,
  LLMSymbol,
  LLMReference,
  AnalysisResult,
} from '@mcp/shared/types.js';
import { FileScanner } from '@mcp/indexer/indexer/scanner.js';
import { TreeSitterExtractor, type TreeSitterResult } from '@mcp/indexer/indexer/tree-sitter/index.js';
import { getIndexJobPool, isIndexWorkersEnabled } from '@mcp/indexer/workers/indexJob/client.js';

/**
 * Enriches LLM-extracted symbol references with line numbers and snippets.
 * If the LLM omits line/snippet, scans the file content for the first occurrence
 * of `\b<symbol_name>\b` and uses that location. Ensures `line` is rarely null.
 */
export function enrichReferencesWithLines(
  references: LLMReference[],
  fileContent: string
): LLMReference[] {
  if (references.length === 0) return references;
  const lines = fileContent.split('\n');

  return references.map(ref => {
    if (ref.line && ref.line > 0 && ref.line <= lines.length) {
      // LLM provided a line — verify by checking it actually contains the symbol; if not, fall through to scan
      const lineText = lines[ref.line - 1] ?? '';
      if (lineText.includes(ref.symbol_name)) {
        return {
          ...ref,
          snippet: ref.snippet ?? lineText.trim().slice(0, 200),
        };
      }
    }

    // Fallback: regex scan for first occurrence
    const escaped = ref.symbol_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        return {
          ...ref,
          line: i + 1,
          snippet: ref.snippet ?? lines[i].trim().slice(0, 200),
        };
      }
    }

    return ref; // No match found anywhere — leave as-is (line will be null)
  });
}

interface IndexOptions {
  force?: boolean;
  concurrency?: number;
  onProgress?: ProgressCallback;
}

export interface EmbeddingProgress {
  current: number;
  total: number;
  percent: number;
}

export interface EmbeddingRetryResult {
  embedded: number;
  skipped: number;
  tokens: number;
}

interface WebhookDispatcherLike {
  dispatch(event: string, project: { id: number; name: string; root_path: string }, data: Record<string, unknown>): Promise<void>;
}

export async function withConcurrency<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
  limit: number
): Promise<void> {
  let index = 0;
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const currentIndex = index++;
    const p = fn(item, currentIndex).then(() => {
      executing.delete(p);
    });
    executing.add(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}

export class IndexAgent {
  constructor(
    private db: CodeIndexDB,
    private provider: LLMProvider,
    private embeddingService: EmbeddingService,
    private vectorStore: VectorStore | null,
    private costTracker: CostTracker,
    private webhookDispatcher: WebhookDispatcherLike | null,
    private config: IndexerConfig
  ) {}

  async indexProject(projectNameOrPath: string, options?: IndexOptions): Promise<IndexResult> {
    const startTime = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalEmbeddingTokens = 0;
    let totalCostUsd = 0;
    let errorCount = 0;

    // 1. Resolve project
    const project = this.db.resolveProject(undefined, projectNameOrPath) ??
      this.db.resolveProject(projectNameOrPath);

    // 2. Scan files
    const scanner = new FileScanner(
      project.root_path,
      this.config.ignorePatterns,
      this.config.maxFileSize
    );
    const scanResult = await scanner.scan(this.db, project.id);

    const toIndex = options?.force
      ? [...scanResult.toIndex, ...scanResult.unchanged.map(path => {
          // Re-read unchanged files for force mode
          const file = this.db.getFile(project.id, path);
          return file ? {
            path: `${project.root_path}/${path}`,
            relativePath: path,
            content: '', // Will need to re-read
            hash: file.content_hash,
            sizeBytes: file.size,
            lineCount: file.line_count,
          } as ScannedFile : null;
        }).filter((f): f is ScannedFile => f !== null)]
      : scanResult.toIndex;

    // 3. Remove deleted files
    for (const path of scanResult.toRemove) {
      const vectorIds = this.db.deleteVectorIdsByFile(project.id, path);
      if (vectorIds.length > 0 && this.vectorStore) {
        try { await this.vectorStore.deleteByIds(vectorIds); } catch { /* ignore */ }
      }
      this.db.deleteFile(project.id, path);
    }

    // 4. Estimate cost + budget check
    const estimate = this.costTracker.estimateCost({
      fileCount: toIndex.length,
      provider: this.provider.name,
      model: this.provider.model,
      embeddingsEnabled: !(this.embeddingService instanceof NullEmbeddingService),
    });
    console.error(`[indexer] Estimated cost: $${estimate.estimatedCostUsd.toFixed(4)} for ${toIndex.length} files`);

    if (this.config.budget && estimate.estimatedCostUsd > this.config.budget) {
      throw new Error(
        `Budget exceeded: estimated cost $${estimate.estimatedCostUsd.toFixed(4)} exceeds budget $${this.config.budget.toFixed(4)}. ` +
        `Use --budget to increase or remove the limit.`
      );
    }

    // 5. Start run
    const runId = this.db.startRun(project.id, this.provider.name, this.provider.model);

    // 6. Process files concurrently
    const concurrency = options?.concurrency ?? this.config.concurrency;
    const indexedFiles: Array<{ path: string; fileId: number; analysis: import('@mcp/shared/types.js').LLMFileAnalysis; content: string; tier?: 'core' | 'support' | 'on_demand' }> = [];
    // Tree-sitter parsing is CPU-bound and was the largest source of main-thread
    // blocking during indexing. When MCP_INDEX_WORKERS=1, dispatch to a worker
    // pool sized to ~min(8, available cores). Result objects are plain JS and
    // structured-clone safe. Worker lifecycle is managed at the process level
    // (via closeIndexJobPool on shutdown), so dispose is a no-op for the pool path.
    const treeSitter: {
      extract(filePath: string, content: string): Promise<TreeSitterResult>;
      dispose(): void;
    } = isIndexWorkersEnabled()
      ? {
          extract: (filePath, content) => getIndexJobPool().extract(filePath, content),
          dispose: () => { /* pool persists across runs */ },
        }
      : new TreeSitterExtractor();
    let treeSitterHits = 0;
    let llmSkipped = 0;

    await withConcurrency(toIndex, async (file, idx) => {
      try {
        // Read content if needed (force mode)
        let content = file.content;
        if (!content && file.path) {
          const { readFileSync } = await import('node:fs');
          content = readFileSync(file.path, 'utf-8');
        }

        // ── Try tree-sitter extraction first (free, <15ms) ─────
        const tsResult = await treeSitter.extract(file.relativePath, content);
        let result: AnalysisResult;

        if (tsResult.supported && tsResult.analysis.symbols && tsResult.analysis.symbols.length > 0) {
          treeSitterHits++;

          // Compute structure hash from sorted symbol signatures
          const structSig = tsResult.analysis.symbols
            .map(s => `${s.kind}:${s.name}:${s.signature}`)
            .sort()
            .join('|');
          const newStructHash = createHash('md5').update(structSig).digest('hex');

          // Check if structure is unchanged — if so, skip LLM entirely
          const oldStructHash = this.db.getFileStructureHash(project.id, file.relativePath);
          const existingFile = this.db.getFile(project.id, file.relativePath);
          const oldStructEmbedding = this.db.getFileStructureEmbedding(project.id, file.relativePath);

          let sim = 0;
          let newStructEmbedding: Float32Array | null = null;

          if (oldStructHash === newStructHash && existingFile && existingFile.summary) {
             sim = 1.0;
          } else if (oldStructEmbedding && existingFile && existingFile.summary) {
             const { vector } = await this.embeddingService.embedQuery(structSig);
             if (vector && vector.length > 0) {
                 newStructEmbedding = new Float32Array(vector);
                 sim = cosineSimilarity(oldStructEmbedding, newStructEmbedding);
             }
          }

          if (sim >= 0.98 && existingFile && existingFile.summary) {
            // Structure unchanged or trivially changed — reuse existing LLM metadata
            llmSkipped++;
            result = {
              analysis: {
                language: tsResult.analysis.language ?? existingFile.language,
                summary: existingFile.summary,
                concepts: JSON.parse(existingFile.concepts || '[]'),
                dependencies: tsResult.analysis.dependencies ?? JSON.parse(existingFile.dependencies || '[]'),
                internal_deps: tsResult.analysis.internal_deps ?? JSON.parse(existingFile.internal_deps || '[]'),
                external_deps: tsResult.analysis.external_deps ?? JSON.parse(existingFile.external_deps || '[]'),
                notes: JSON.parse(existingFile.notes || '[]'),
                complexity: existingFile.complexity,
                layer: existingFile.layer,
                is_entry_point: !!existingFile.is_entry_point,
                is_test: !!existingFile.is_test,
                is_generated: !!existingFile.is_generated,
                symbols: tsResult.analysis.symbols,
                references: tsResult.analysis.references ?? [],
              },
              inputTokens: 0,
              outputTokens: 0,
            };
          } else {
            // Structure changed — need LLM for summary
            let llmResult;
            if (sim >= 0.90 && this.provider.analyzeSummary) {
               // Use cheaper prompt (skeleton) for moderate structural changes
               llmResult = await this.provider.analyzeSummary(file.relativePath, content, tsResult.analysis.symbols);
            } else {
               // Fallback to full content analysis for major structural mutations
               llmResult = await this.provider.analyzeFile(file.relativePath, content);
            }

            result = {
              analysis: {
                ...llmResult.analysis,
                symbols: tsResult.analysis.symbols,
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

          // Compute embedding if it was not computed during similarity check
          if (!newStructEmbedding && sim !== 1.0) {
              const { vector } = await this.embeddingService.embedQuery(structSig);
              if (vector && vector.length > 0) newStructEmbedding = new Float32Array(vector);
          }

          // Store structure hash and embedding — will be persisted after upsertFile below
          (tsResult as { _structHash?: string })._structHash = newStructHash;
          (tsResult as { _structEmbedding?: Float32Array })._structEmbedding = newStructEmbedding ?? undefined;
        } else {
          // Unsupported language — full LLM analysis as before
          result = await this.provider.analyzeFile(file.relativePath, content);
        }

        // Record cost
        const cost = this.costTracker.record({
          projectId: project.id,
          runId,
          provider: this.provider.name,
          model: this.provider.model,
          operation: 'analysis',
          filePath: file.relativePath,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });

        totalInputTokens += result.inputTokens;
        totalOutputTokens += result.outputTokens;
        totalCostUsd += cost;

        // Upsert file (tier persisted by the auto-mapper at scan time;
        // missing on legacy callers and reindexes from before migration 071)
        const fileId = this.db.upsertFile(project.id, {
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

        // Persist structure hash and embedding if tree-sitter produced one
        if (tsResult.supported && (tsResult as { _structHash?: string })._structHash) {
          this.db.setFileStructureHash(fileId, (tsResult as { _structHash?: string })._structHash!);
        }
        if (tsResult.supported && (tsResult as { _structEmbedding?: Float32Array })._structEmbedding) {
          this.db.setFileStructureEmbedding(fileId, (tsResult as { _structEmbedding?: Float32Array })._structEmbedding!);
        }

        // Upsert symbols
        this.db.upsertSymbols(project.id, fileId, file.relativePath, result.analysis.symbols);

        // Upsert file dependencies
        this.db.upsertFileDependencies(project.id, fileId, file.relativePath, result.analysis.internal_deps, result.analysis.external_deps);

        // Upsert symbol references — fallback to regex scan for missing line/snippet
        if (result.analysis.references && result.analysis.references.length > 0) {
          const enriched = enrichReferencesWithLines(result.analysis.references, content);
          this.db.upsertSymbolReferences(project.id, fileId, file.relativePath, enriched);
        }

        // Save file snapshot for diff
        this.db.saveFileSnapshot({
          runId,
          projectId: project.id,
          filePath: file.relativePath,
          contentHash: file.hash,
          summary: result.analysis.summary,
          concepts: result.analysis.concepts,
          symbols: result.analysis.symbols,
        });

        indexedFiles.push({ path: file.relativePath, fileId, analysis: result.analysis, content, tier: file.tier });

        // Release the scanner's copy of the content. The indexedFiles entry
        // keeps its own reference (needed for embeddings later), but freeing
        // the ScannedFile.content here halves peak memory during the LLM
        // analysis phase for large codebases.
        (file as { content: string }).content = '';

        // Progress callback
        options?.onProgress?.({
          current: idx + 1,
          total: toIndex.length,
          currentFile: file.relativePath,
          elapsedMs: Date.now() - startTime,
          costUsd: totalCostUsd,
        });
      } catch (err) {
        errorCount++;
        console.error(`[indexer] Error processing ${file.relativePath}:`, err);
      }
    }, concurrency);

    // 7-11. Embeddings (if available)
    const vectorsAvailable = this.vectorStore && !(this.embeddingService instanceof NullEmbeddingService)
      ? await this.vectorStore.isAvailable()
      : false;

    if (vectorsAvailable && this.vectorStore) {
      try {
        await this.processEmbeddings(project, runId, indexedFiles);
      } catch (err) {
        console.error('[indexer] Embedding pipeline error:', err);
      }
    }

    // Release file content from indexedFiles — embeddings are done, and these
    // strings can be hundreds of MB in aggregate for large codebases.
    for (const f of indexedFiles) (f as { content: string }).content = '';

    // Cleanup tree-sitter parsers
    treeSitter.dispose();
    if (treeSitterHits > 0) {
      console.error(`[indexer] Tree-sitter: ${treeSitterHits}/${toIndex.length} files from AST; ${llmSkipped} LLM calls skipped (structure unchanged)`);
    }

    // 12. Update project counters
    const stats = this.db.getStats(project.id);
    this.db.updateProject(project.id, {
      file_count: stats.file_count,
      symbol_count: stats.symbol_count,
      last_indexed: new Date().toISOString(),
    });

    // 13. Finish run
    const status = errorCount > toIndex.length / 2 ? 'failed' : 'completed';
    this.db.finishRun(runId, {
      status: status as 'completed' | 'failed',
      totalFiles: scanResult.toIndex.length + scanResult.unchanged.length,
      indexedFiles: indexedFiles.length,
      skippedFiles: scanResult.unchanged.length,
      errorCount,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      embeddingTokens: totalEmbeddingTokens,
      estimatedCostUsd: totalCostUsd,
    });

    // 14. Dispatch webhooks
    if (this.webhookDispatcher) {
      const event = status === 'completed' ? 'index.done' : 'index.failed';
      try {
        await this.webhookDispatcher.dispatch(event, project, {
          run_id: runId,
          indexed_files: indexedFiles.length,
          error_count: errorCount,
          cost_usd: totalCostUsd,
        });
      } catch { /* ignore webhook errors */ }
    }

    // 15. Auto-snapshots (uses ALL files from DB, not just newly indexed)
    await this.generateAutoSnapshots(project);

    // 16. Return result
    return {
      runId,
      totalFiles: scanResult.toIndex.length + scanResult.unchanged.length,
      indexedFiles: indexedFiles.length,
      skippedFiles: scanResult.unchanged.length,
      errorCount,
      durationMs: Date.now() - startTime,
      costUsd: totalCostUsd,
    };
  }

  // ── Embedding candidate type ──────────────────────────────────
  private _candidateType!: {
    text: string;
    id: string;
    filePath: string;
    metadata: Record<string, string>;
    hash: string;
    onCommit: () => void;
  };

  /**
   * Build embedding candidates from a list of files with their analysis data
   * and content. Shared by processEmbeddings (after LLM analysis) and
   * retryEmbeddings (standalone, reading from DB + disk).
   */
  private buildEmbeddingCandidates(
    project: { id: number; name: string },
    files: Array<{
      path: string;
      fileId: number;
      language: string;
      summary: string;
      concepts: string[];
      symbols: Array<{ name: string; kind: string; signature?: string | null; comment?: string | null; line?: number | null }>;
      content: string;
    }>
  ): typeof this._candidateType[] {
    type Candidate = typeof this._candidateType;
    const candidates: Candidate[] = [];

    const fileIds = files.map((f) => f.fileId);
    const fileHashMap = this.db.getFileEmbeddingHashes(fileIds);

    const allSymbolIds: number[] = [];
    const symIdMapByFile = new Map<string, Map<string, number>>();
    for (const file of files) {
      const dbSymbols = this.db.getSymbolsByFile(project.id, file.path);
      const map = new Map(dbSymbols.map((s) => [`${s.kind}:${s.name}`, s.id]));
      symIdMapByFile.set(file.path, map);
      for (const s of dbSymbols) allSymbolIds.push(s.id);
    }
    const symHashMap = this.db.getSymbolEmbeddingHashes(allSymbolIds);

    const MIN_BODY_LINES = Number(process.env.MCP_INDEX_BODY_MIN_LINES ?? 8);
    const MAX_BODY_CHARS = Number(process.env.MCP_INDEX_BODY_MAX_CHARS ?? 2500);

    for (const file of files) {
      // ── File-level embedding ───────────────────────────────────
      const fileText = [
        `File: ${file.path}`,
        `Language: ${file.language}`,
        `Summary: ${file.summary}`,
        `Concepts: ${file.concepts.join(', ')}`,
        `Symbols: ${file.symbols.map((s) => s.name).join(', ')}`,
      ]
        .join('\n')
        .slice(0, 1000);

      const fileHash = createHash('md5').update(fileText).digest('hex');
      const fileVecId =
        'f_' + createHash('md5').update(`${project.id}:${file.path}`).digest('hex').slice(0, 24);
      const storedFileHash = fileHashMap.get(file.fileId) ?? null;

      if (storedFileHash !== fileHash) {
        candidates.push({
          text: fileText,
          id: fileVecId,
          filePath: file.path,
          metadata: {
            project_name: project.name,
            type: 'file',
            ref_id: String(file.fileId),
          },
          hash: fileHash,
          onCommit: () => this.db.setFileEmbeddingHash(file.fileId, fileHash),
        });
      }

      // ── Symbol-level embeddings ────────────────────────────────
      const symIdMap = symIdMapByFile.get(file.path) ?? new Map<string, number>();

      const sortedSymbols = [...file.symbols]
        .filter((s) => ['class', 'function', 'interface', 'method'].includes(s.kind))
        .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));

      const fileLines = file.content.split(/\r?\n/);
      const skippedSymbols: Array<{ sym: any; symDbId: number; lineStart: number; lineEnd: number }> = [];

      for (let i = 0; i < sortedSymbols.length; i++) {
        const sym = sortedSymbols[i];
        const symDbId = symIdMap.get(`${sym.kind}:${sym.name}`);
        if (!symDbId) continue;

        const globalContext = [
          `File: ${file.path}`,
          file.summary ? `Summary: ${file.summary}` : '',
          file.concepts.length ? `Concepts: ${file.concepts.join(', ')}` : ''
        ].filter(Boolean).join(' | ');

        // ── Signature/comment embedding (always) ────────────────
        const sigText = [
          `[Context: ${globalContext}]`,
          `${sym.kind}: ${sym.name}`,
          sym.signature ? `Signature: ${sym.signature}` : '',
          sym.comment ? `Description: ${sym.comment}` : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 1000);

        const sigHash = createHash('md5').update(sigText).digest('hex');
        const symVecId =
          's_' + createHash('md5').update(`${project.id}:${file.path}:${sym.name}`).digest('hex').slice(0, 24);
        const storedSigHash = symHashMap.get(symDbId)?.sig ?? null;

        if (storedSigHash !== sigHash) {
          candidates.push({
            text: sigText,
            id: symVecId,
            filePath: file.path,
            metadata: {
              project_name: project.name,
              type: 'symbol',
              ref_id: String(symDbId),
            },
            hash: sigHash,
            onCommit: () => this.db.setSymbolEmbeddingHash(symDbId, sigHash, 'sig'),
          });
        }

        // ── Body embedding (only for substantial symbols) ───────
        if (sym.line === null || sym.line === undefined) continue;

        const lineStart = Math.max(0, sym.line - 1);
        // Use tree-sitter's precise end_line when available, fallback to next symbol heuristic
        const symEndLine = (sym as { end_line?: number }).end_line;
        let lineEnd: number;
        if (symEndLine) {
          // AST-aware: exact end boundary from tree-sitter
          lineEnd = Math.min(fileLines.length, symEndLine);
        } else {
          // Heuristic fallback: use next symbol's start line
          const nextSym = sortedSymbols[i + 1];
          const nextLine = nextSym?.line ?? fileLines.length + 1;
          lineEnd = Math.min(fileLines.length, nextLine - 1);
        }
        const spanLines = lineEnd - lineStart;
        if (spanLines < MIN_BODY_LINES) {
          skippedSymbols.push({ sym, symDbId, lineStart, lineEnd });
          continue;
        }

        const bodySlice = fileLines.slice(lineStart, lineEnd).join('\n').slice(0, MAX_BODY_CHARS);
        const bodyText = `[Context: ${globalContext}]\n${sym.kind} ${sym.name}\n${sym.signature ?? ''}\n---\n${bodySlice}`;
        const bodyHash = createHash('md5').update(bodyText).digest('hex');
        const bodyVecId =
          'sb_' +
          createHash('md5').update(`${project.id}:${file.path}:${sym.name}:body`).digest('hex').slice(0, 23);
        const storedBodyHash = symHashMap.get(symDbId)?.body ?? null;

        if (storedBodyHash !== bodyHash) {
          candidates.push({
            text: bodyText,
            id: bodyVecId,
            filePath: file.path,
            metadata: {
              project_name: project.name,
              type: 'symbol_body',
              ref_id: String(symDbId),
            },
            hash: bodyHash,
            onCommit: () => this.db.setSymbolEmbeddingHash(symDbId, bodyHash, 'body'),
          });
        }
      }

      // ── cAST Sibling Merging (Second Pass) ─────────────────
      if (skippedSymbols.length > 0) {
        skippedSymbols.sort((a, b) => a.lineStart - b.lineStart);
        const MCP_INDEX_SIBLING_GAP = 3;
        const MCP_INDEX_GROUP_MIN_LINES = 3;

        let currentGroup: typeof skippedSymbols = [];
        let groupChars = 0;

        const processGroup = () => {
          if (currentGroup.length === 0) return;
          const first = currentGroup[0];
          const last = currentGroup[currentGroup.length - 1];
          const totalLines = last.lineEnd - first.lineStart;

          if (totalLines >= MCP_INDEX_GROUP_MIN_LINES) {
            const bodyParts = currentGroup.map(item => {
              const slice = fileLines.slice(item.lineStart, item.lineEnd).join('\n');
              return `method ${item.sym.name}: ${item.sym.signature ?? '()'}\n---\n${slice}`;
            });
            const globalContext = [
              `File: ${file.path}`,
              file.summary ? `Summary: ${file.summary}` : '',
              file.concepts.length ? `Concepts: ${file.concepts.join(', ')}` : ''
            ].filter(Boolean).join(' | ');
            const bodyText = `[Context: ${globalContext}]\n[group] File: ${file.path} (parent: ${first.sym.parent ?? 'None'})\n\n${bodyParts.join('\n\n')}`;

            const bodyHash = createHash('md5').update(bodyText).digest('hex');
            
            const sgVecId = 'sg_' + createHash('md5')
              .update(`${project.id}:${file.path}:${first.sym.name}:${last.sym.name}`)
              .digest('hex').slice(0, 22);

            const anchorSymDbId = first.symDbId;
            const storedBodyHash = symHashMap.get(anchorSymDbId)?.body ?? null;

            if (storedBodyHash !== bodyHash) {
              candidates.push({
                text: bodyText.slice(0, MAX_BODY_CHARS),
                id: sgVecId,
                filePath: file.path,
                metadata: {
                  project_name: project.name,
                  type: 'symbol_group',
                  ref_id: String(anchorSymDbId),
                },
                hash: bodyHash,
                onCommit: () => this.db.setSymbolEmbeddingHash(anchorSymDbId, bodyHash, 'body'),
              });
            }
          }
        };

        for (let j = 0; j < skippedSymbols.length; j++) {
          const item = skippedSymbols[j];
          if (currentGroup.length === 0) {
            currentGroup.push(item);
            groupChars += (item.lineEnd - item.lineStart) * 50; // estimate
            continue;
          }

          const prev = currentGroup[currentGroup.length - 1];
          const gap = item.lineStart - prev.lineEnd;
          const sameParent = item.sym.parent === prev.sym.parent;
          
          if (gap <= MCP_INDEX_SIBLING_GAP && sameParent && groupChars < MAX_BODY_CHARS) {
            currentGroup.push(item);
            groupChars += (item.lineEnd - item.lineStart) * 50;
          } else {
            processGroup();
            currentGroup = [item];
            groupChars = (item.lineEnd - item.lineStart) * 50;
          }
        }
        processGroup(); // flush last
      }
    }

    return candidates;
  }

  /**
   * Embed candidates and upsert to vector store. Shared by processEmbeddings
   * and retryEmbeddings.
   */
  private async executeEmbedding(
    project: { id: number },
    runId: number | null,
    candidates: typeof this._candidateType[]
  ): Promise<number> {
    const { vectors, tokens } = await this.embeddingService.embed(candidates.map((c) => c.text));

    if (runId !== null) {
      this.costTracker.record({
        projectId: project.id,
        runId,
        provider: 'cloudflare',
        model: '@cf/baai/bge-m3',
        operation: 'embedding',
        inputTokens: tokens,
        outputTokens: 0,
      });
    }

    const vectorRecords: VectorRecord[] = candidates.map((c, i) => ({
      id: c.id,
      values: vectors[i],
      metadata: c.metadata,
    }));

    await this.vectorStore!.upsert(vectorRecords);

    this.db.saveVectorIds(
      project.id,
      candidates.map((c) => ({
        vectorId: c.id,
        filePath: c.filePath,
        type: c.metadata.type as 'file' | 'symbol' | 'symbol_body',
      }))
    );
    for (const c of candidates) c.onCommit();

    return tokens;
  }

  private async processEmbeddings(
    project: { id: number; name: string },
    runId: number,
    indexedFiles: Array<{ path: string; fileId: number; analysis: import('@mcp/shared/types.js').LLMFileAnalysis; content: string; tier?: 'core' | 'support' | 'on_demand' }>
  ): Promise<void> {
    // Aggressive profile skips embeddings for `on_demand` files (tests,
    // docs, migrations, fixtures). They stay searchable via FTS but
    // no longer consume embedding tokens or vector store rows. Files
    // without a tier (legacy / pre-migration-071 entries) are treated
    // as `support` and embedded.
    const profile = this.config.indexProfile ?? 'balanced';
    const skipped: string[] = [];
    const eligible = indexedFiles.filter((f) => {
      if (profile === 'aggressive' && f.tier === 'on_demand') {
        skipped.push(f.path);
        return false;
      }
      return true;
    });

    if (skipped.length > 0) {
      console.error(`[indexer] Skipping ${skipped.length} on_demand embedding(s) (aggressive profile)`);
    }

    const files = eligible.map((f) => ({
      path: f.path,
      fileId: f.fileId,
      language: f.analysis.language,
      summary: f.analysis.summary,
      concepts: f.analysis.concepts,
      symbols: f.analysis.symbols,
      content: f.content,
    }));

    const candidates = this.buildEmbeddingCandidates(project, files);

    if (candidates.length === 0) {
      console.error('[indexer] All embeddings up to date — skipping embed pipeline');
      return;
    }

    console.error(`[indexer] Embedding ${candidates.length} new/changed records`);

    const CHUNK = 50;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const chunk = candidates.slice(i, i + CHUNK);
      await this.executeEmbedding(project, runId, chunk);
    }
  }

  /**
   * Retry embedding for all files in a project that have missing or outdated
   * embedding hashes. Reads file metadata from DB and content from disk —
   * no LLM analysis needed.
   */
  async retryEmbeddings(
    projectNameOrPath: string,
    options?: { onProgress?: (p: EmbeddingProgress) => void }
  ): Promise<EmbeddingRetryResult> {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const vectorsAvailable = this.vectorStore && !(this.embeddingService instanceof NullEmbeddingService)
      ? await this.vectorStore.isAvailable()
      : false;

    if (!vectorsAvailable || !this.vectorStore) {
      throw new Error('Embedding service or vector store not available');
    }

    const project = this.db.resolveProject(undefined, projectNameOrPath) ??
      this.db.resolveProject(projectNameOrPath);

    const dbFiles = this.db.listFiles(project.id);

    // Build file entries with content read from disk
    const files: Array<{
      path: string;
      fileId: number;
      language: string;
      summary: string;
      concepts: string[];
      symbols: Array<{ name: string; kind: string; signature?: string | null; comment?: string | null; line?: number | null }>;
      content: string;
    }> = [];

    for (const dbFile of dbFiles) {
      let content: string;
      try {
        content = readFileSync(join(project.root_path, dbFile.path), 'utf-8');
      } catch {
        continue; // file removed from disk — skip
      }

      const dbSymbols = this.db.getSymbolsByFile(project.id, dbFile.path);
      files.push({
        path: dbFile.path,
        fileId: dbFile.id,
        language: dbFile.language,
        summary: dbFile.summary,
        concepts: JSON.parse(dbFile.concepts || '[]') as string[],
        symbols: dbSymbols.map((s) => ({
          name: s.name,
          kind: s.kind,
          signature: s.signature,
          comment: s.comment,
          line: s.line,
        })),
        content,
      });
    }

    const candidates = this.buildEmbeddingCandidates(project, files);
    const total = candidates.length;

    if (total === 0) {
      options?.onProgress?.({ current: 0, total: 0, percent: 100 });
      return { embedded: 0, skipped: dbFiles.length, tokens: 0 };
    }

    console.error(`[indexer] Retry embedding: ${total} candidates from ${files.length} files`);

    // Embed in smaller chunks so we can report progress
    const CHUNK = 50;
    let embedded = 0;
    let totalTokens = 0;

    for (let i = 0; i < candidates.length; i += CHUNK) {
      const chunk = candidates.slice(i, i + CHUNK);
      const tokens = await this.executeEmbedding(project, null, chunk);
      embedded += chunk.length;
      totalTokens += tokens;
      options?.onProgress?.({
        current: embedded,
        total,
        percent: Math.round((embedded / total) * 100),
      });
    }

    return { embedded, skipped: dbFiles.length - files.length, tokens: totalTokens };
  }

  private async generateAutoSnapshots(
    project: { id: number; name: string }
  ): Promise<void> {
    // Load ALL files and symbols from DB (not just newly indexed)
    const allDbFiles = this.db.listFiles(project.id);
    if (allDbFiles.length === 0) return;

    // Delete previous auto-generated snapshots to replace with fresh data
    const existing = this.db.listSnapshots(project.id);
    for (const snap of existing) {
      try {
        const tags = JSON.parse(snap.tags) as string[];
        if (tags.includes('auto-generated')) this.db.deleteSnapshot(snap.id);
      } catch { /* ignore */ }
    }

    // Collect analytics from all DB files
    const languages = new Map<string, number>();
    const allConcepts = new Map<string, number>();
    const layers = new Map<string, string[]>();
    const complexities: Record<string, number> = { low: 0, medium: 0, high: 0, 'very-high': 0 };
    const entryPoints: string[] = [];
    const testFiles: string[] = [];
    const highComplexity: Array<{ path: string; complexity: string }> = [];
    const externalDeps = new Set<string>();

    // Build file-level data from DB records
    const filePaths: Array<{ path: string; lower: string }> = [];

    for (const f of allDbFiles) {
      languages.set(f.language, (languages.get(f.language) ?? 0) + 1);

      try {
        const concepts = JSON.parse(f.concepts) as string[];
        for (const c of concepts) allConcepts.set(c, (allConcepts.get(c) ?? 0) + 1);
      } catch { /* ignore */ }

      const layer = f.layer ?? 'unknown';
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer)!.push(f.path);

      if (f.complexity in complexities) complexities[f.complexity]++;
      if (f.complexity === 'high' || f.complexity === 'very-high') {
        highComplexity.push({ path: f.path, complexity: f.complexity });
      }

      if (f.is_entry_point) entryPoints.push(f.path);
      if (f.is_test) testFiles.push(f.path);

      try {
        const extDeps = JSON.parse(f.external_deps) as string[];
        for (const dep of extDeps) externalDeps.add(dep);
      } catch { /* ignore */ }

      filePaths.push({ path: f.path, lower: f.path.toLowerCase() });
    }

    // Load all symbols from DB
    const allSymbols: Array<{ path: string; name: string; kind: string; signature: string; parent: string | null; modifiers: string[]; comment: string | null; extends_from?: string; implements_list?: string[] }> = [];

    for (const f of allDbFiles) {
      const symbols = this.db.getSymbolsByFile(project.id, f.path);
      for (const sym of symbols) {
        let mods: string[] = [];
        try { mods = JSON.parse(sym.modifiers) as string[]; } catch { /* ignore */ }

        // Get relations for extends/implements
        let extendsFrom: string | undefined;
        let implementsList: string[] | undefined;
        const relations = this.db.getSymbolRelations(sym.id);
        if (relations) {
          const ext = relations.find(r => r.relation_type === 'extends');
          if (ext) extendsFrom = ext.related_symbol_name;
          const impls = relations.filter(r => r.relation_type === 'implements');
          if (impls.length > 0) implementsList = impls.map(i => i.related_symbol_name);
        }

        allSymbols.push({
          path: f.path,
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature,
          parent: sym.parent,
          modifiers: mods,
          comment: sym.comment,
          extends_from: extendsFrom,
          implements_list: implementsList,
        });
      }
    }

    const totalFiles = allDbFiles.length;

    // ─── 1. Architecture Overview ────────────────────────────────
    const langLines = Array.from(languages.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `- **${lang}**: ${count} files`)
      .join('\n');

    const layerLines = Array.from(layers.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([layer, files]) => `- **${layer}**: ${files.length} files (${files.slice(0, 5).join(', ')}${files.length > 5 ? ` +${files.length - 5} more` : ''})`)
      .join('\n');

    const archContent = [
      `# Architecture Overview`,
      ``,
      `**${totalFiles} files** indexed across **${languages.size} languages**`,
      ``,
      `## Languages`,
      langLines,
      ``,
      `## Layers`,
      layerLines,
      ``,
      `## Complexity Distribution`,
      `- Low: ${complexities.low} | Medium: ${complexities.medium} | High: ${complexities.high} | Very-High: ${complexities['very-high']}`,
      entryPoints.length > 0 ? `\n## Entry Points\n${entryPoints.map(p => `- ${p}`).join('\n')}` : '',
      testFiles.length > 0 ? `\n## Test Files\n${testFiles.length} test files detected` : '',
    ].filter(Boolean).join('\n');

    this.db.createSnapshot(project.id, {
      title: 'Architecture Overview',
      category: 'architecture',
      content: archContent,
      tags: ['auto-generated', 'architecture'],
      createdBy: 'auto',
    });

    // ─── 2. Patterns Detected ────────────────────────────────────
    const patterns = this.detectArchitecturalPatterns(filePaths);
    if (patterns.length > 0) {
      this.db.createSnapshot(project.id, {
        title: 'Design Patterns',
        category: 'pattern',
        content: `# Design Patterns Detected\n\n${patterns.map(p => `## ${p.name}\n${p.description}\n\nFiles:\n${p.files.map(f => `- ${f}`).join('\n')}`).join('\n\n')}`,
        tags: ['auto-generated', 'patterns'],
        createdBy: 'auto',
      });
    }

    // ─── 3. Key Concepts ─────────────────────────────────────────
    const topConcepts = Array.from(allConcepts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30);

    if (topConcepts.length > 0) {
      const conceptLines = topConcepts.map(([concept, count]) => `- **${concept}** (${count} files)`).join('\n');
      this.db.createSnapshot(project.id, {
        title: 'Key Concepts',
        category: 'note',
        content: `# Key Concepts\n\nTop concepts found across the codebase:\n\n${conceptLines}`,
        tags: ['auto-generated', 'concepts'],
        createdBy: 'auto',
      });
    }

    // ─── 4. Class/Interface Hierarchy ────────────────────────────
    const classes = allSymbols.filter(s => s.kind === 'class' || s.kind === 'interface');
    const hierarchyEntries: string[] = [];

    for (const cls of classes) {
      const parts: string[] = [`### ${cls.kind} \`${cls.name}\` — ${cls.path}`];
      if (cls.signature) parts.push(`Signature: \`${cls.signature}\``);
      if (cls.comment) parts.push(cls.comment);
      if (cls.extends_from) parts.push(`Extends: \`${cls.extends_from}\``);
      if (cls.implements_list?.length) parts.push(`Implements: ${cls.implements_list.map(i => `\`${i}\``).join(', ')}`);

      // Find members
      const members = allSymbols.filter(s => s.parent === cls.name && s.path === cls.path);
      if (members.length > 0) {
        parts.push(`Members (${members.length}):`);
        for (const m of members) {
          parts.push(`- ${m.kind} \`${m.name}\`${m.signature ? `: ${m.signature}` : ''}`);
        }
      }
      hierarchyEntries.push(parts.join('\n'));
    }

    if (hierarchyEntries.length > 0) {
      this.db.createSnapshot(project.id, {
        title: 'Classes & Interfaces',
        category: 'architecture',
        content: `# Classes & Interfaces\n\n${hierarchyEntries.length} classes/interfaces found:\n\n${hierarchyEntries.join('\n\n')}`,
        tags: ['auto-generated', 'hierarchy'],
        createdBy: 'auto',
      });
    }

    // ─── 5. External Dependencies ────────────────────────────────
    if (externalDeps.size > 0) {
      const sorted = Array.from(externalDeps).sort();
      this.db.createSnapshot(project.id, {
        title: 'External Dependencies',
        category: 'note',
        content: `# External Dependencies\n\n${sorted.length} external dependencies detected:\n\n${sorted.map(d => `- \`${d}\``).join('\n')}`,
        tags: ['auto-generated', 'dependencies'],
        createdBy: 'auto',
      });
    }

    // ─── 6. High Complexity Files (if any) ───────────────────────
    if (highComplexity.length > 0) {
      this.db.createSnapshot(project.id, {
        title: 'High Complexity Files',
        category: 'todo',
        content: `# High Complexity Files\n\nThese files have high or very-high complexity and may benefit from refactoring:\n\n${highComplexity.map(f => `- **${f.path}** (${f.complexity})`).join('\n')}`,
        tags: ['auto-generated', 'complexity', 'tech-debt'],
        createdBy: 'auto',
      });
    }

    // ─── 7. Public API Surface ───────────────────────────────────
    const exportedFunctions = allSymbols.filter(s =>
      (s.kind === 'function' || s.kind === 'method') &&
      (s.modifiers.includes('export') || s.modifiers.includes('public')) &&
      !s.parent // top-level exports
    );

    if (exportedFunctions.length > 0) {
      const grouped = new Map<string, typeof exportedFunctions>();
      for (const f of exportedFunctions) {
        if (!grouped.has(f.path)) grouped.set(f.path, []);
        grouped.get(f.path)!.push(f);
      }

      const apiLines = Array.from(grouped.entries())
        .map(([path, fns]) => `### ${path}\n${fns.map(f => `- \`${f.signature || f.name}\`${f.comment ? ` — ${f.comment}` : ''}`).join('\n')}`)
        .join('\n\n');

      this.db.createSnapshot(project.id, {
        title: 'Public API Surface',
        category: 'convention',
        content: `# Public API Surface\n\nExported functions and entry points:\n\n${apiLines}`,
        tags: ['auto-generated', 'api-surface'],
        createdBy: 'auto',
      });
    }

    // ─── 8. Conventions Detected ─────────────────────────────────
    const conventions: string[] = [];

    // Detect naming conventions
    const funcNames = allSymbols.filter(s => s.kind === 'function' || s.kind === 'method').map(s => s.name);
    const camelCount = funcNames.filter(n => /^[a-z][a-zA-Z0-9]*$/.test(n)).length;
    const snakeCount = funcNames.filter(n => /^[a-z][a-z0-9_]*$/.test(n) && n.includes('_')).length;
    if (funcNames.length > 3) {
      if (camelCount > snakeCount * 2) conventions.push('- **Naming**: camelCase for functions/methods');
      else if (snakeCount > camelCount * 2) conventions.push('- **Naming**: snake_case for functions/methods');
    }

    // Detect file organization
    const dirStructure = new Map<string, number>();
    for (const f of allDbFiles) {
      const dir = f.path.split('/').slice(0, -1).join('/');
      if (dir) dirStructure.set(dir, (dirStructure.get(dir) ?? 0) + 1);
    }
    const topDirs = Array.from(dirStructure.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (topDirs.length > 0) {
      conventions.push(`- **Directory structure**:\n${topDirs.map(([d, c]) => `  - \`${d}/\` (${c} files)`).join('\n')}`);
    }

    // Detect common patterns in symbols
    const hasTypes = allSymbols.some(s => s.kind === 'type' || s.kind === 'interface');
    if (hasTypes) conventions.push('- **Types**: Uses explicit type definitions/interfaces');

    const hasTests = testFiles.length > 0;
    if (hasTests) conventions.push(`- **Testing**: ${testFiles.length} test files (${((testFiles.length / totalFiles) * 100).toFixed(0)}% coverage by file count)`);

    if (conventions.length > 0) {
      this.db.createSnapshot(project.id, {
        title: 'Project Conventions',
        category: 'convention',
        content: `# Project Conventions\n\nDetected conventions and patterns:\n\n${conventions.join('\n')}`,
        tags: ['auto-generated', 'conventions'],
        createdBy: 'auto',
      });
    }
  }

  private detectArchitecturalPatterns(
    files: Array<{ path: string; lower: string }>
  ): Array<{ name: string; description: string; files: string[] }> {
    const patterns: Array<{ name: string; description: string; files: string[] }> = [];
    const pathMap = files;

    // MVC / Service Layer
    const controllers = pathMap.filter(p => p.lower.includes('controller'));
    const services = pathMap.filter(p => p.lower.includes('service') && !p.lower.includes('worker'));
    if (controllers.length > 0 && services.length > 0) {
      patterns.push({
        name: 'MVC / Service Layer',
        description: `${controllers.length} controllers + ${services.length} services. Controllers handle routing/input, services contain business logic.`,
        files: [...controllers.map(c => c.path), ...services.map(s => s.path)],
      });
    }

    // Repository Pattern
    const repos = pathMap.filter(p => p.lower.includes('repository') || p.lower.includes('repo') || p.lower.match(/store.*db|db.*store/));
    if (repos.length > 0) {
      patterns.push({
        name: 'Repository / Data Access',
        description: `${repos.length} data access files. Centralized database access through repository abstraction.`,
        files: repos.map(r => r.path),
      });
    }

    // Middleware
    const middleware = pathMap.filter(p => p.lower.includes('middleware'));
    if (middleware.length > 0) {
      patterns.push({
        name: 'Middleware Pipeline',
        description: `${middleware.length} middleware files. Request/response processing chain.`,
        files: middleware.map(m => m.path),
      });
    }

    // Provider / Strategy Pattern
    const providers = pathMap.filter(p => p.lower.includes('provider'));
    if (providers.length >= 2) {
      patterns.push({
        name: 'Provider / Strategy Pattern',
        description: `${providers.length} provider implementations. Multiple interchangeable implementations behind a common interface.`,
        files: providers.map(p => p.path),
      });
    }

    // Factory Pattern
    const factories = pathMap.filter(p => p.lower.includes('factory'));
    if (factories.length > 0) {
      patterns.push({
        name: 'Factory Pattern',
        description: `${factories.length} factory files. Object creation through factory methods.`,
        files: factories.map(f => f.path),
      });
    }

    // Hooks / Composables
    const hooks = pathMap.filter(p => p.lower.includes('hook') || p.lower.includes('composable') || p.lower.match(/use[A-Z]/));
    if (hooks.length > 0) {
      patterns.push({
        name: 'Hooks / Composables',
        description: `${hooks.length} hook/composable files. Reusable stateful logic units.`,
        files: hooks.map(h => h.path),
      });
    }

    // State Management
    const stateFiles = pathMap.filter(p => p.lower.includes('store') || p.lower.includes('redux') || p.lower.includes('zustand') || p.lower.includes('state'));
    if (stateFiles.length > 0) {
      patterns.push({
        name: 'State Management',
        description: `${stateFiles.length} state management files.`,
        files: stateFiles.map(s => s.path),
      });
    }

    // Workers / Background Processing
    const workers = pathMap.filter(p => p.lower.includes('worker') || p.lower.includes('queue') || p.lower.includes('job'));
    if (workers.length > 0) {
      patterns.push({
        name: 'Workers / Background Processing',
        description: `${workers.length} worker/job files. Background task processing.`,
        files: workers.map(w => w.path),
      });
    }

    // Event-Driven / Pub-Sub
    const events = pathMap.filter(p => p.lower.includes('event') || p.lower.includes('emitter') || p.lower.includes('webhook') || p.lower.includes('dispatcher'));
    if (events.length > 0) {
      patterns.push({
        name: 'Event-Driven / Webhooks',
        description: `${events.length} event/webhook files. Async communication via events or webhooks.`,
        files: events.map(e => e.path),
      });
    }

    // API Routes
    const routes = pathMap.filter(p => p.lower.includes('route') || p.lower.includes('api/') || p.lower.includes('endpoint'));
    if (routes.length > 0) {
      patterns.push({
        name: 'API Routes',
        description: `${routes.length} route/API files. HTTP endpoint definitions.`,
        files: routes.map(r => r.path),
      });
    }

    // Configuration Management
    const configs = pathMap.filter(p => p.lower.includes('config'));
    if (configs.length > 0) {
      patterns.push({
        name: 'Configuration Management',
        description: `${configs.length} config files. Centralized configuration with environment variable overrides.`,
        files: configs.map(c => c.path),
      });
    }

    return patterns;
  }
}

export function cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
