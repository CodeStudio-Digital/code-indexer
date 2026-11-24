/** Aggregate only human-labeled outcomes. Duplicate evaluations don't raise coverage. */
export interface ClefObservation {
  key: string;
  shown: boolean;
  correct: boolean;
  baselineCorrect: boolean;
}
export const clefPolicyVersion = 'v1';
// Clef Flash, synthetic-v1, 2026-11-23. Both baselines use the cases shown within 800 ms.
const pilotCounts = {
  company: { total: 100, shown: 64, correct: 64, baselineCorrect: 48 },
  chat: { total: 120, shown: 41, correct: 40, baselineCorrect: 6 },
};

function score(total: number, shown: number, correct: number, baselineCorrect: number) {
  const coverage = total ? shown / total : 0;
  const accuracy = shown ? correct / shown : 0;
  const baselineAccuracy = shown ? baselineCorrect / shown : 0;
  return {
    labeled: total,
    coverage,
    accuracy,
    baselineAccuracy,
    qualified:
      total >= 100 &&
      coverage >= 0.5 &&
      accuracy >= 0.9 &&
      accuracy - baselineAccuracy >= 0.05 - Number.EPSILON,
  };
}

export function clefQualification(kind: keyof typeof pilotCounts, samples: ClefObservation[]) {
  const field = evaluateClef(samples);
  const counts = pilotCounts[kind];
  const pilot = score(counts.total, counts.shown, counts.correct, counts.baselineCorrect);
  const basis = field.labeled >= 100 ? 'installation' : 'pilot';
  return { ...field, pilot, basis, canSuggest: basis === 'installation' ? field.qualified : pilot.qualified };
}

export function evaluateClef(samples: ClefObservation[]) {
  const shown = samples.filter((row) => row.shown);
  return score(
    samples.length,
    shown.length,
    shown.filter((r) => r.correct).length,
    shown.filter((r) => r.baselineCorrect).length,
  );
}
