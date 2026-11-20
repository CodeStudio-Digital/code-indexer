import type { SearchDiagnostics } from '@mcp/indexer/search/hybrid.js';

/** Structural + generation coverage needed only for zero/degraded results. */
interface CoverageCounts {
  files_total: number;
  semantic_expected: number;
  semantic_indexed: number;
  pending_delta_items?: number;
}

/**
 * Why the vector stream contributed nothing, as a stable reason code the
 * agent can act on. Null when the vector path looked healthy.
 */
export function vectorIssue(diag: SearchDiagnostics): string | null {
  // Preserve the concrete owner/worker error even when availability is false;
  // callers should not have to claim a backend is available merely to surface
  // why it could not be reached.
  if (diag.vectorError) return `vector_error: ${diag.vectorError}`;
  if (!diag.vectorAvailable) return 'vector_store_unavailable';
  if (!diag.embeddingAvailable) return 'embedding_unavailable';
  return null;
}

function describeMode(requestedMode: string, diag: SearchDiagnostics): string {
  if (diag.plannerMode) return `${diag.plannerMode} (planner: ${diag.plannerReason ?? 'auto'})`;
  return requestedMode;
}

/**
 * Replacement for the bare 'No results found.' — tells the agent WHAT ran
 * and what was degraded, so "zero results" can be read as "the healthy
 * streams found nothing" vs "the semantic stream never ran". Without this,
 * agents concluded "the code doesn't exist" when embeddings were down or
 * files were tier-excluded from embedding.
 */
export function renderZeroResultDiagnostics(
  requestedMode: string,
  diag: SearchDiagnostics,
  getCoverage: () => CoverageCounts,
): string {
  const issue = vectorIssue(diag);
  const parts = [
    `mode=${describeMode(requestedMode, diag)}`,
    diag.ftsCount !== undefined ? `fts_hits=${diag.ftsCount}` : null,
    issue ? `vector=failed: ${issue}` : `vector=ok (raw_matches=${diag.vectorRawMatches ?? 0})`,
  ].filter(Boolean);

  const lines = ['No results found.', `[diagnostics] ${parts.join(' | ')}`];
  if (issue) {
    lines.push(
      'Semantic search did not run for this query — absence here does NOT mean the code does not exist. Use grep_code (exact text, has disk fallback) before concluding anything is missing.',
    );
  }

  const cov = safeCoverage(getCoverage);
  if (cov && cov.files_total === 0) {
    // No structural index at all — symbols/FTS/content are all empty.
    lines.push(
      'This project has NO index yet (not even the structural layer) — zero results are meaningless. Open the project to trigger the auto structural index, or run indexing manually; grep_code disk fallback works meanwhile.',
    );
  } else if (cov && cov.files_total > 0 && cov.semantic_indexed === 0) {
    lines.push(
      'Index is STRUCTURAL-ONLY (symbols/FTS/content); no active semantic vectors are available yet. Prefer exact identifiers or grep_code; semantic absence is NOT evidence of absence.',
    );
  } else if (cov && cov.semantic_expected > 0 && cov.semantic_indexed < cov.semantic_expected) {
    lines.push(
      `Semantic generation coverage is ${cov.semantic_indexed}/${cov.semantic_expected} items; grep_code and structural search still cover the project while backfill continues.`,
    );
  }
  if (cov?.pending_delta_items && cov.pending_delta_items > 0) {
    lines.push(
      `${cov.pending_delta_items} semantic delta item(s) are pending; structural data (symbols/grep) remains current.`,
    );
  }
  return lines.join('\n');
}

/**
 * One-line trailer appended to NON-empty results when the vector stream
 * failed: the hits are FTS-only, so the agent should calibrate confidence
 * (a missing semantic match is not evidence of absence).
 */
export function renderDegradedTrailer(diag: SearchDiagnostics): string | null {
  const issue = vectorIssue(diag);
  if (!issue) return null;
  return `[note: vector search failed (${issue}) — results above are FTS-only; semantic misses are not evidence of absence]`;
}

function safeCoverage(getCoverage: () => CoverageCounts): CoverageCounts | null {
  try {
    return getCoverage();
  } catch {
    return null; // diagnostics must never break the search result itself
  }
}
