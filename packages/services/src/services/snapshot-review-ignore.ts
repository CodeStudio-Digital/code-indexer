/**
 * Path filtering for snapshot review.
 *
 * Some files churn in the snapshot log but are never worth an AI review:
 * the indexer's own internal folder (`.mcp-indexer/` — trash, worktrees,
 * coder tool-outputs), VCS metadata, dependencies, and build output. When the
 * agent deletes a source file it gets moved under `.mcp-indexer/trash/...`,
 * which the reviewer would otherwise flag as "deleted file being re-added".
 *
 * This filter is applied at every review entry point (the dashboard
 * "Revisão automática" route, the code-agent `self_review` tool, the master
 * `review_subordinate_work` tool, and defensively inside the pipeline) so the
 * ignore rule is identical for any agent or for the user.
 *
 * Mirrors the ignore set used by the glob tool (packages/code-agent glob.ts).
 */

/** Path segments whose contents are never reviewed. */
export const REVIEW_IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  '.mcp-indexer',
  '.git',
  'node_modules',
  'dist',
]);

/** True when a project-relative path should be reviewed (not ignored). */
export function isReviewablePath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/);
  return !segments.some((seg) => REVIEW_IGNORED_SEGMENTS.has(seg));
}

/** Drop diffs whose file lives under an ignored segment (e.g. `.mcp-indexer/**`). */
export function filterReviewableDiffs<T extends { baseline: { filePath: string } }>(
  diffs: readonly T[],
): T[] {
  return diffs.filter((d) => isReviewablePath(d.baseline.filePath));
}
