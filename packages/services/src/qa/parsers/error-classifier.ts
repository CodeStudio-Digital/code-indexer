/**
 * B7 — pure classifier for QA test-failure messages.
 *
 * The streaming reporter POSTs each spec's failure text verbatim; this
 * module maps that free text onto the machine-readable `error_class`
 * vocabulary (migration 189) so the test-event route can detect "the
 * shared Chrome Service died mid-run" and complete the run early
 * instead of letting every remaining spec fail one by one.
 *
 * Heuristics, not AST — Playwright error banners are stable enough
 * that substring/regex matching is reliable in practice:
 *
 *   sidecar_down          → the spec could not talk to the shared
 *                           browser container (connection refused, WS
 *                           dropped, target/browser closed under it).
 *   reporter_unreachable  → the failure text is about the reporter's
 *                           own POST to `/qa/test-event` failing (the
 *                           browser is fine; the dashboard link isn't).
 *   null                  → a regular test failure (assertion, timeout
 *                           on a locator, etc.) — not infra.
 *
 * Pure: no I/O, no Date, no env. Import from anywhere.
 */

export type QaFailureClass = 'sidecar_down' | 'reporter_unreachable' | null;

/**
 * Reporter-side markers checked FIRST: an ECONNREFUSED aimed at the
 * test-event endpoint is a reporter problem, not a browser problem —
 * without this precedence it would be swallowed by the sidecar rules.
 */
const REPORTER_MARKERS: RegExp[] = [
  /\/qa\/test-event/i,
  /PLAYWRIGHT_QA_ENDPOINT/i,
  /reporter.{0,40}(POST|fetch).{0,40}(fail|error)/is,
];

/** Browser/sidecar connectivity markers (Playwright banners + Node errno). */
const SIDECAR_MARKERS: RegExp[] = [
  /browserType\.connect/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /websocket.{0,40}(closed|error|disconnected)/is,
  /\bws\b.{0,20}closed/is,
  /target closed/i,
  /target page, context or browser has been closed/i,
  /browser has been (closed|disconnected)/i,
  /connection closed/i,
];

/**
 * Classify one failure message. `null`/`undefined`/empty input → null
 * (nothing to classify — treat as an ordinary failure).
 */
export function classifyQaFailure(message: string | null | undefined): QaFailureClass {
  if (!message || typeof message !== 'string') return null;

  if (REPORTER_MARKERS.some((re) => re.test(message))) {
    return 'reporter_unreachable';
  }
  if (SIDECAR_MARKERS.some((re) => re.test(message))) {
    return 'sidecar_down';
  }
  return null;
}
