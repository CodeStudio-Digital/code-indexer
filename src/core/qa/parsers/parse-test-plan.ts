/**
 * Pure parser for `tests/e2e/TEST_PLAN.md`.
 *
 * Extracts the structured shape the dashboard's TestPlanView needs:
 * priority sections (P0/P1/P2/Cross-cutting/Dependencies/…) and the
 * bullet-list scenarios under each. We deliberately keep the parser
 * tolerant — the QA agent writes the markdown, and we don't want
 * brittle requirements that fight the model.
 *
 * Conventions recognised (mirrors what `qa-playwright.md` instructs the
 * agent to write):
 *   - Sections start with `### <heading>`. Anything before the first
 *     `###` is treated as a preamble and discarded.
 *   - Inside a section, lines starting with `- ` (or `* `) are
 *     scenarios. Bold prefix (`**name**`) is allowed; the parser keeps
 *     the full text untouched as `text`.
 *   - A pipe table (the Coverage table) is parsed loosely: if a row's
 *     cells include a path like `tests/e2e/<file>.spec.ts`, that path
 *     attaches as `specFile` to the matching scenario by exact-text
 *     comparison (case-insensitive trimmed). If no match, the row is
 *     skipped silently — the bullets are the source of truth, the
 *     table is an extra hint.
 *
 * Pure: no I/O, no Node-only APIs. Exported for tests + the frontend.
 */
import type { QaTestPlanScenario, QaTestPlanSection } from '../types.js';

const HEADING_RE = /^###\s+(.+?)\s*$/;
const SCENARIO_RE = /^[*-]\s+(.+?)\s*$/;
/** "P0", "P1", "Cross-cutting" → captures "P0" / "Cross-cutting" / null. */
const PRIORITY_RE = /\(([^)]+)\)\s*$/;
const TABLE_ROW_RE = /^\|(.+)\|\s*$/;

export interface ParsedTestPlan {
  sections: QaTestPlanSection[];
}

export function parseTestPlanSections(markdown: string): ParsedTestPlan {
  const lines = markdown.split(/\r?\n/);
  const sections: QaTestPlanSection[] = [];
  let current: QaTestPlanSection | null = null;
  const tableRows: Array<{ scenario: string; specFile: string | null }> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const heading = headingMatch[1];
      const priorityMatch = heading.match(PRIORITY_RE);
      current = {
        heading,
        priority: priorityMatch ? priorityMatch[1] : null,
        scenarios: [],
      };
      sections.push(current);
      continue;
    }

    if (!current) continue; // pre-section content ignored

    const scenarioMatch = line.match(SCENARIO_RE);
    if (scenarioMatch) {
      current.scenarios.push({ text: stripBoldPrefix(scenarioMatch[1]) });
      continue;
    }

    const tableMatch = line.match(TABLE_ROW_RE);
    if (tableMatch) {
      const cells = tableMatch[1].split('|').map((c) => c.trim());
      // Skip header + separator rows (separator has only --- cells).
      const isSeparator = cells.every((c) => /^:?-+:?$/.test(c));
      const isHeader = cells.some((c) => /^scenario\b/i.test(c));
      if (isSeparator || isHeader) continue;
      const scenario = cells[0];
      const spec = cells.find((c) => /tests\/e2e\/.+\.spec\.[tj]s/.test(c)) ?? null;
      if (scenario) tableRows.push({ scenario, specFile: spec });
    }
  }

  // Cross-reference table rows back into scenarios.
  if (tableRows.length > 0) {
    const norm = (s: string) => stripBoldPrefix(s).toLowerCase().trim();
    for (const row of tableRows) {
      const target = norm(row.scenario);
      for (const section of sections) {
        for (const scenario of section.scenarios) {
          if (norm(scenario.text).includes(target) || target.includes(norm(scenario.text))) {
            attachSpec(scenario, row.specFile);
          }
        }
      }
    }
  }

  return { sections };
}

function stripBoldPrefix(text: string): string {
  return text.replace(/^\*\*(.+?)\*\*\s*[—:-]?\s*/, '$1 ').trim();
}

function attachSpec(scenario: QaTestPlanScenario, specFile: string | null): void {
  if (specFile && !scenario.specFile) {
    scenario.specFile = specFile;
  }
}
