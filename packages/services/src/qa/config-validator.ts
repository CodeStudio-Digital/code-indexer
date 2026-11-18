/**
 * B7 — pure validator for the user-facing `playwright.config.ts`.
 *
 * Complements `validatePlaywrightConfig` (playwright-bootstrap.ts): that
 * one powers the DRIFT panel (soft warnings + recommended sibling file);
 * this one is the HARD gate consulted by `qa_start_run` before a run row
 * is created — a config that cannot possibly stream results or reach the
 * shared browser fails fast with an actionable message instead of
 * producing a doomed `running` row.
 *
 * Checks (regex/heuristic — agents reformat, so no AST):
 *   1. `connectOptions.wsEndpoint` wired to `process.env.PLAYWRIGHT_WS_ENDPOINT`
 *      (directly or via an intermediate const). Without it, Playwright
 *      tries to LAUNCH a local browser — which doesn't exist in the
 *      sandbox image.
 *   2. The custom streaming reporter (`./tests/e2e/reporter.ts`) still
 *      referenced — without it Tab Testes never receives events and the
 *      watchdog kills the run as orphan.
 *   3. `baseURL` fed from env (`process.env.PLAYWRIGHT_BASE_URL`) — a
 *      hardcoded localhost resolves to the CHROME SERVICE container,
 *      not the app container.
 *
 * Pure: string in, verdict out. No I/O.
 */

export interface QaConfigValidation {
  ok: boolean;
  /** Human-readable problems, one per failed check. Empty when ok. */
  problems: string[];
  /** Single actionable next step, present only when !ok. */
  suggestion?: string;
}

const SUGGESTION =
  'Diff against playwright.config.recommended.ts (written next to your config) ' +
  'or click "Restore QA config" on the Tests tab; do NOT pass --reporter on the CLI.';

/** Check 1 — remote browser wiring. */
function hasWsEndpointWiring(content: string): boolean {
  if (!content.includes('PLAYWRIGHT_WS_ENDPOINT')) return false;
  return /connectOptions/.test(content) && /wsEndpoint/.test(content);
}

/** Check 2 — streaming reporter still present. */
function hasStreamingReporter(content: string): boolean {
  return /tests\/e2e\/reporter/.test(content);
}

/** Check 3 — baseURL comes from env. */
function hasEnvBaseUrl(content: string): boolean {
  if (!/baseURL/.test(content)) return false;
  return /process\.env\.PLAYWRIGHT_BASE_URL/.test(content);
}

/**
 * Validate the config content. Callers should SKIP validation when the
 * file does not exist yet (fresh scaffold in flight) — pass only real
 * file contents here.
 */
export function validateQaRunConfig(content: string): QaConfigValidation {
  const problems: string[] = [];

  if (!hasWsEndpointWiring(content)) {
    problems.push(
      'connectOptions.wsEndpoint is not wired to process.env.PLAYWRIGHT_WS_ENDPOINT — ' +
        'the suite would try to launch a local browser, which does not exist in the sandbox.',
    );
  }
  if (!hasStreamingReporter(content)) {
    problems.push(
      "the streaming reporter ('./tests/e2e/reporter.ts') was removed from `reporter:` — " +
        'the dashboard would receive zero events and the watchdog would kill the run as orphan.',
    );
  }
  if (!hasEnvBaseUrl(content)) {
    problems.push(
      'baseURL is not read from process.env.PLAYWRIGHT_BASE_URL — hardcoded hosts resolve ' +
        'to the browser host.',
    );
  }

  return problems.length === 0
    ? { ok: true, problems: [] }
    : { ok: false, problems, suggestion: SUGGESTION };
}
