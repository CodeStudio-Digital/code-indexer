/**
 * file-path-core — PURE shared rules for validating agent-supplied
 * relative paths (company drive + docs tools) and content-size caps.
 *
 * Single source of truth for the checks that used to live duplicated in
 * `CompanyDriveStore.validatePath` (drive, 4MB cap) and
 * `docs-tools.resolveDocPath` (docs, 256KB cap). Both call sites keep
 * their intentional divergences via the parameters below:
 *
 *   - traversal: the drive rejects only exact `..` SEGMENTS (names like
 *     "..foo" stay legal — folder uploads contain weird names); docs
 *     reject any `..` SUBSTRING (stricter — a doc path never needs it).
 *   - caps: docs cap content at 256KB, the drive at 4MB.
 *
 * No Node imports, no I/O — safe for the dashboard and for unit tests.
 */

/** Drive namespace that mirrors the sandbox `docs/` tree (docs-tools). */
export const DOCS_MIRROR_PREFIX = '__docs__/';

/** Max bytes `docs_write` accepts (mirrors the sandbox doc cap). */
export const DOCS_CONTENT_CAP_BYTES = 256 * 1024;

/** Max bytes a single company-drive write/append may total. */
export const DRIVE_WRITE_CAP_BYTES = 4 * 1024 * 1024;

/** Default max path length (chars) — inherited from the drive rules. */
export const DEFAULT_MAX_PATH_LENGTH = 512;

/**
 * Reject control characters (0x00–0x1F). Everything else printable is
 * fine — folder uploads frequently contain spaces, parens, accents, '+'.
 */
const CONTROL_CHARS_RE = /[\x00-\x1f]/;

export type PathCheck = { ok: true } | { ok: false; message: string };

export interface RelPathRules {
  /** Max length in chars. Default 512. */
  maxLength?: number;
  /**
   * `'segment'` (drive): reject only path segments that are exactly
   * `..` — still allows names like `..foo`.
   * `'substring'` (docs): reject any occurrence of `..` anywhere.
   * Default `'segment'`.
   */
  traversal?: 'segment' | 'substring';
}

/**
 * Validate a relative, forward-slash path. Returns `{ ok: false }` with
 * a human-readable message (kept byte-for-byte compatible with the old
 * `CompanyDriveStore.validatePath` errors) on the first failing rule.
 */
export function checkRelativePath(p: string, rules: RelPathRules = {}): PathCheck {
  const maxLength = rules.maxLength ?? DEFAULT_MAX_PATH_LENGTH;
  const traversal = rules.traversal ?? 'segment';

  if (!p) return fail('path is required');
  if (p.length > maxLength) return fail(`path is too long (>${maxLength} chars)`);
  if (p.includes('\0')) return fail('path must not contain null bytes');
  if (CONTROL_CHARS_RE.test(p)) return fail('path must not contain control characters');
  if (p.includes('\\')) return fail('path must use forward slashes ("/"), not backslashes');
  if (p.startsWith('/')) return fail('path must be relative (no leading "/")');

  if (traversal === 'substring') {
    if (p.includes('..')) return fail('path must not contain ".."');
  } else {
    for (const seg of p.split('/')) {
      if (seg === '..') return fail('path must not contain ".." segments');
    }
  }
  return { ok: true };
}

/** Throwing variant — drop-in for the old `validatePath` (drive). */
export function assertRelativePath(p: string, rules: RelPathRules = {}): void {
  const res = checkRelativePath(p, rules);
  if (!res.ok) throw new Error(res.message);
}

/**
 * Check a content byte-size against a cap. `label` names the limit in
 * the message (e.g. "content"), matching the old inline errors.
 */
export function checkContentSize(byteLength: number, capBytes: number): PathCheck {
  if (byteLength > capBytes) {
    return fail(`content exceeds ${capBytes} bytes (got ${byteLength})`);
  }
  return { ok: true };
}

/** True when the path lives in the docs mirror namespace. */
export function isDocsMirrorPath(p: string): boolean {
  return p.startsWith(DOCS_MIRROR_PREFIX);
}

function fail(message: string): PathCheck {
  return { ok: false, message };
}
