/**
 * Pure `.npmrc` line surgery for design-system links. A linked project
 * resolves its DS scope (`@acme:registry=http://127.0.0.1:4873`) from the
 * local Verdaccio while every other package keeps following the user's
 * defaults — so a later bare `npm install` by the agent or the user still
 * works. String-in/string-out: callers own the fs read/write.
 */

/** `@acme/ui` → `@acme`; unscoped names (`ui`) have no scope to map. */
export function packageScope(packageName: string): string | null {
  const m = /^(@[^/]+)\//.exec(packageName);
  return m ? m[1] : null;
}

function detectEol(content: string | null): string {
  return content && content.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function scopeLineRe(scope: string): RegExp {
  // Escape is unnecessary: scopes are `@[word/-]+` — but keep it literal-safe.
  const esc = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${esc}:registry\\s*=`);
}

export interface UpsertNpmrcResult {
  content: string;
  changed: boolean;
  /** False when the package has no scope — caller must pass --registry instead. */
  scoped: boolean;
}

/**
 * Insert or replace the `@scope:registry=<url>` line, preserving every
 * unrelated line and the file's EOL style. Idempotent.
 */
export function upsertNpmrcScopedRegistry(
  existing: string | null,
  packageName: string,
  registryUrl: string,
): UpsertNpmrcResult {
  const scope = packageScope(packageName);
  if (!scope) return { content: existing ?? '', changed: false, scoped: false };

  const eol = detectEol(existing);
  const line = `${scope}:registry=${registryUrl}`;
  if (!existing || existing.trim() === '') {
    return { content: line + eol, changed: true, scoped: true };
  }

  const re = scopeLineRe(scope);
  const lines = splitLines(existing);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx >= 0) {
    if (lines[idx] === line) return { content: existing, changed: false, scoped: true };
    lines[idx] = line;
    return { content: lines.join(eol), changed: true, scoped: true };
  }
  // Append, keeping a single trailing newline.
  const body = existing.endsWith('\n') || existing.endsWith('\r\n') ? existing : existing + eol;
  return { content: body + line + eol, changed: true, scoped: true };
}

export interface RemoveNpmrcResult {
  content: string;
  changed: boolean;
}

/** Drop the `@scope:registry=` line for this package, if present. */
export function removeNpmrcScopedRegistry(
  existing: string | null,
  packageName: string,
): RemoveNpmrcResult {
  const scope = packageScope(packageName);
  if (!scope || !existing) return { content: existing ?? '', changed: false };
  const re = scopeLineRe(scope);
  const eol = detectEol(existing);
  const lines = splitLines(existing);
  const kept = lines.filter((l) => !re.test(l));
  if (kept.length === lines.length) return { content: existing, changed: false };
  return { content: kept.join(eol), changed: true };
}
