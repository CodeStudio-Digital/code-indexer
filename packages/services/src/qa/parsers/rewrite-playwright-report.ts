/**
 * Pure: rewrite relative URLs inside the Playwright HTML report so the
 * browser fetches every asset back through our `/qa/playwright-report`
 * endpoint with the correct `service` query string.
 *
 * Why this is needed:
 *   - Playwright generates `playwright-report/index.html` with relative
 *     `<link href="styles.css">`, `<script src="app.js">`, `<img src="...">`
 *     pointing at sibling files in `playwright-report/`.
 *   - When we serve `index.html` via `/qa/playwright-report?service=api`,
 *     a relative `styles.css` resolves to `/qa/styles.css` — outside the
 *     whitelisted prefix, returning 404.
 *
 * The fix: walk every `href`, `src`, and `srcset` attribute and prepend
 * the route prefix + service param. Absolute URLs and data: URIs pass
 * through untouched.
 *
 * We use a regex sweep instead of a real HTML parser:
 *   - The Playwright report is generated, not user-authored, so it
 *     stays consistent.
 *   - cheerio / parse5 would 5x the bundle for a single page rewrite.
 *
 * Exported standalone for unit testing — the route is just glue.
 */

export interface RewriteOptions {
  sessionId: number;
  serviceId: string;
  /**
   * Path of the HTML being served, used to resolve `./foo.css` against.
   * For `index.html` at the root of `playwright-report/`, this is just
   * `playwright-report/`. The prefix that gets prepended already
   * includes the `playwright-report/` segment via the route, so we only
   * need to know the directory of the current file inside that.
   */
  filePath: string;
}

const ATTR_RE = /\b(href|src)=("([^"]*)"|'([^']*)')/gi;
const SRCSET_RE = /\bsrcset=("([^"]*)"|'([^']*)')/gi;

/**
 * Pure: rewrite a single URL value. Absolute / hash / data / mailto /
 * blob URIs pass through; relative paths get rewritten to the artifact
 * route.
 */
export function rewriteUrl(value: string, opts: RewriteOptions): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('//') || // protocol-relative — let the browser resolve
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  ) {
    return value;
  }
  // Strip leading `./`
  const cleaned = trimmed.replace(/^\.\//, '');
  // `playwright-report/` is the route prefix; the file path tells us
  // which subdirectory the current file is in. We resolve `cleaned`
  // relative to the directory of `filePath` and present the resolved
  // path back as `?file=<resolved>`.
  const baseDir = dirOf(opts.filePath);
  const resolved = resolveRelative(baseDir, cleaned);
  const sp = new URLSearchParams();
  sp.set('service', opts.serviceId);
  sp.set('file', resolved);
  return `/api/company/sessions/${opts.sessionId}/qa/playwright-report?${sp.toString()}`;
}

/**
 * Pure: rewrite the body of the playwright-report HTML. Operates on
 * the source string; no DOM. Handles `href`, `src`, and `srcset`.
 */
export function rewritePlaywrightReportHtml(html: string, opts: RewriteOptions): string {
  const afterAttrs = html.replace(ATTR_RE, (full, attr, _quoted, dq, sq) => {
    const orig = dq ?? sq ?? '';
    const next = rewriteUrl(orig, opts);
    return `${attr}="${next}"`;
  });
  return afterAttrs.replace(SRCSET_RE, (full, _quoted, dq, sq) => {
    const orig = dq ?? sq ?? '';
    const rewritten = orig
      .split(',')
      .map((entry: string) => {
        const t = entry.trim();
        if (!t) return t;
        const [url, ...rest] = t.split(/\s+/);
        const next = rewriteUrl(url, opts);
        return [next, ...rest].join(' ');
      })
      .join(', ');
    return `srcset="${rewritten}"`;
  });
}

/** Pure: directory of a path, with trailing slash; root file → ''. */
function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '';
  return path.slice(0, idx + 1);
}

/**
 * Pure: resolve a relative path against a base directory, collapsing
 * `..` and `.` segments. Always returns an unprefixed, forward-slash
 * path. Works for our limited needs — not a full POSIX resolver.
 */
export function resolveRelative(baseDir: string, rel: string): string {
  const stack = baseDir.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join('/');
}
