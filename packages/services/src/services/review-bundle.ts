/**
 * ReviewBundle — the artifact an AI reviewer consumes INSTEAD of a raw diff
 * (Onda 2 do review nativo de IA).
 *
 * Principle: push the summary, pull the detail. The bundle aggregates every
 * review-relevant signal the IDE owns, each computed by its own module:
 *
 *   ledger    — shape-classified pending hunks (review-hunk-shape.ts)
 *   contract  — the intent compiled into obligations (intent-contract.ts)
 *   absences  — untouched call sites of contract-changed symbols
 *               (review-absences.ts)
 *   evidence  — recorded verify runs + staleness (code-agent review-evidence)
 *   priors    — calibration learned from finding fates (review-fates.ts)
 *
 * `reviewSessionSnapshots` builds one bundle and serializes slices of it into
 * the pipeline prompt; the reviewer-subagent path (Onda 3) consumes the same
 * object through the code_exec `change` API instead of a serialized prompt.
 * Every part is best-effort: a missing dependency yields a smaller bundle,
 * never a failed review.
 */
import type { FileDiff } from './session-snapshots.js';
import { classifyHunk, type HunkShape } from './review-hunk-shape.js';
import {
  buildAbsenceReport,
  formatAbsencesSection,
  type AbsenceEntry,
  type ReviewReferenceLookup,
} from './review-absences.js';
import {
  formatContractSection,
  type IntentObligation,
} from './intent-contract.js';
import { buildEnclosingSymbolContext, formatReviewContext } from './snapshot-review-context.js';

export interface ReviewBundleLedger {
  files: number;
  pendingHunks: number;
  shapeCounts: Partial<Record<HunkShape, number>>;
}

export interface ReviewBundle {
  scope: { sessionKind: 'coder' | 'company'; sessionId: number };
  ledger: ReviewBundleLedger;
  obligations: IntentObligation[] | null;
  absences: AbsenceEntry[];
  /** Serialized prompt slices (null = section absent). */
  contractText: string | null;
  absencesText: string | null;
  contextText: string | null;
}

export interface BuildReviewBundleInput {
  sessionKind: 'coder' | 'company';
  sessionId: number;
  diffs: FileDiff[];
  focus?: string | null;
  intent?: string | null;
  evidence?: string | null;
  priors?: string | null;
  referenceLookup?: ReviewReferenceLookup;
  /** Pre-compiled obligations (the entrypoint owns the compiler + cache). */
  obligations?: IntentObligation[] | null;
}

function buildLedger(diffs: FileDiff[]): ReviewBundleLedger {
  const shapeCounts: Partial<Record<HunkShape, number>> = {};
  let pendingHunks = 0;
  for (const diff of diffs) {
    if (diff.diffDisabled) continue;
    for (const hunk of diff.hunks) {
      if (hunk.decision !== 'pending') continue;
      pendingHunks++;
      const { shape } = classifyHunk(diff.baseline.filePath, hunk, diff.currentContent);
      shapeCounts[shape] = (shapeCounts[shape] ?? 0) + 1;
    }
  }
  return { files: diffs.length, pendingHunks, shapeCounts };
}

export async function buildReviewBundle(input: BuildReviewBundleInput): Promise<ReviewBundle> {
  let absences: AbsenceEntry[] = [];
  if (input.referenceLookup) {
    try {
      absences = await buildAbsenceReport(input.diffs, input.referenceLookup);
    } catch {
      absences = [];
    }
  }
  const obligations = input.obligations ?? null;
  return {
    scope: { sessionKind: input.sessionKind, sessionId: input.sessionId },
    ledger: buildLedger(input.diffs),
    obligations,
    absences,
    contractText: obligations ? formatContractSection(obligations) : null,
    absencesText: formatAbsencesSection(absences),
    contextText: formatReviewContext({
      focus: input.focus,
      intent: input.intent,
      evidence: input.evidence,
      priors: input.priors,
      symbols: buildEnclosingSymbolContext(input.diffs),
    }),
  };
}
