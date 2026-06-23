/**
 * Pure: given a parsed TEST_PLAN and a flat list of recent
 * `QaTestResult` rows (newest first), label each scenario with its
 * latest verdict. Powers the green/red dots next to scenarios in the
 * TestPlanView.
 *
 * Heuristic — match by case-insensitive normalised substring on
 * `test_name`. The QA agent's specs typically name tests after the
 * scenario phrasing (e.g. scenario "login with valid credentials" maps
 * to `test('login with valid credentials', ...)`). When no result
 * matches, the scenario stays `not-run`.
 *
 * Stays a pure function — no DB calls, no React state. The hook layer
 * fetches results once and passes them in.
 */
import type {
  QaTestPlanScenario,
  QaTestPlanSection,
  QaTestResult,
  QaTestStatus,
} from '../types.js';

export type ScenarioVerdict = QaTestStatus | 'not-run';

export interface AnnotatedScenario extends QaTestPlanScenario {
  verdict: ScenarioVerdict;
  /** Reference to the result we matched against (for click-through). */
  resultId: number | null;
}

export interface AnnotatedSection extends Omit<QaTestPlanSection, 'scenarios'> {
  scenarios: AnnotatedScenario[];
}

export function matchPlanToResults(
  sections: QaTestPlanSection[],
  results: QaTestResult[],
): AnnotatedSection[] {
  // Build a quick lookup: lowercased test_name → latest result row.
  // `results` arrives newest-first; first wins.
  const byName = new Map<string, QaTestResult>();
  for (const r of results) {
    const key = normalise(r.test_name);
    if (!byName.has(key)) byName.set(key, r);
  }

  return sections.map((section) => ({
    ...section,
    scenarios: section.scenarios.map((scenario) => {
      const match = findMatch(scenario, byName);
      return {
        ...scenario,
        verdict: match ? match.status : 'not-run',
        resultId: match?.id ?? null,
      };
    }),
  }));
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findMatch(
  scenario: QaTestPlanScenario,
  byName: Map<string, QaTestResult>,
): QaTestResult | null {
  const target = normalise(scenario.text);
  if (byName.has(target)) return byName.get(target)!;

  // Fallback: substring match in either direction (scenario text is
  // often longer than the test name due to the bold-prefix convention).
  for (const [name, result] of byName) {
    if (name.includes(target) || target.includes(name)) return result;
  }
  return null;
}
