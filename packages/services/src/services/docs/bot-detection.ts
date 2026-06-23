/**
 * Bot-block / SPA-shell detection.
 *
 * Inspects a `RenderResult` (status, body, content type) and returns the
 * list of signals that suggest the page was either rejected by a bot
 * detector OR is a JavaScript-rendered shell whose static HTML is
 * useless for retrieval.
 *
 * Used by `EscalatingFetcher` (render-backend.ts) — non-empty list means
 * "retry with a real browser if one is available".
 *
 * Signals are intentionally cheap (string contains + regex tally), no
 * full DOM parse. The penalty of a false positive is one extra browser
 * page render (~1-2s); the penalty of a false negative is indexing 5
 * lines of nav scaffolding instead of real docs.
 */
import type { RenderResult } from './render-backend.js';

const HARD_BLOCK_STATUSES = new Set([403, 429, 451, 503]);
const MIN_OK_BODY_BYTES = 500;
const SPA_SHELL_MAX_TEXT = 200;
const SPA_SHELL_MIN_SCRIPTS = 3;

const CLOUDFLARE_MARKERS = [
  'just a moment',
  'cf-browser-verification',
  'cf-challenge',
  'attention required! | cloudflare',
];

const JS_REQUIRED_MARKERS = [
  'please enable javascript',
  'javascript is required',
  'this site requires javascript',
];

/**
 * Return an array of detection signals. Empty array means "looks fine".
 *
 * Signals (stable strings — surfaced in telemetry, so don't rename
 * without a search-and-replace across logs/UI):
 *   - `http_<status>`      — hard-block status code
 *   - `body_too_short`     — 200 OK with suspiciously small body
 *   - `cloudflare_challenge` — page contains Cloudflare challenge markers
 *   - `spa_shell`          — body is mostly `<script>` with little text
 *   - `js_required_notice` — explicit "please enable JS" message
 */
export function detectBlocked(result: RenderResult): string[] {
  const signals: string[] = [];

  if (HARD_BLOCK_STATUSES.has(result.status)) {
    signals.push(`http_${result.status}`);
  }

  if (result.status === 200 && result.bytes < MIN_OK_BODY_BYTES) {
    signals.push('body_too_short');
  }

  const lc = result.html.toLowerCase();

  if (CLOUDFLARE_MARKERS.some((m) => lc.includes(m))) {
    signals.push('cloudflare_challenge');
  }

  // Quick SPA-shell heuristic: count <script> tags vs visible text length.
  const scriptCount = countMatches(lc, /<script[\s>]/g);
  const textLen = stripTags(result.html).length;
  if (textLen < SPA_SHELL_MAX_TEXT && scriptCount >= SPA_SHELL_MIN_SCRIPTS) {
    signals.push('spa_shell');
  }

  if (JS_REQUIRED_MARKERS.some((m) => lc.includes(m))) {
    signals.push('js_required_notice');
  }

  return signals;
}

function countMatches(text: string, re: RegExp): number {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
