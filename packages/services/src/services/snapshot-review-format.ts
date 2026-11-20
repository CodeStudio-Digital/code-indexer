/**
 * Render snapshot-review findings as a compact, actionable block for an agent
 * (the code-agent self-review tool, or the master reviewing a subordinate).
 *
 * This is the "for the model to act on" sibling of `buildFeedbackMessage` in
 * snapshot-review-routes.ts (which formats DB comment rows as markdown for the
 * dashboard). Here we format raw findings and tell the agent what to do next.
 */
import type { SnapshotReviewFinding, SnapshotReviewSeverity } from './snapshot-review-pipeline.js';

const SEVERITY_ORDER: Record<SnapshotReviewSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function formatFindingsForAgent(findings: SnapshotReviewFinding[]): string {
  if (findings.length === 0) {
    return 'Review complete: no issues found in the pending changes.';
  }
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const lines: string[] = [`Review found ${findings.length} item(s) (most severe first):`, ''];
  for (const f of sorted) {
    const loc =
      f.newLine != null
        ? `${f.filePath}:${f.newLine}`
        : f.oldLine != null
          ? `${f.filePath}:${f.oldLine}`
          : f.filePath;
    const tag =
      f.kind === 'missing_change'
        ? ' [missing change — file NOT touched this session]'
        : f.kind === 'unfulfilled_obligation'
          ? ` [unfulfilled obligation${f.obligationId ? ` ${f.obligationId}` : ''}]`
          : f.kind === 'scope_creep'
            ? ' [scope creep — no obligation explains this change]'
            : '';
    lines.push(`- [${f.severity}] ${loc}${tag}`);
    lines.push(`  ${f.body.trim()}`);
    if (f.suggestedFix && f.suggestedFix.trim()) {
      lines.push(`  suggested fix: ${f.suggestedFix.trim()}`);
    }
  }
  lines.push('');
  lines.push(
    'Decide which are worth it. For each one you accept, apply the fix with ' +
      'edit_file (pass edits for several changes in one file); skip the ones that do not make sense — you do not have to accept all.',
  );
  return lines.join('\n');
}
