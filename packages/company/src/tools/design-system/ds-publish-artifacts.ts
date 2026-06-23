/**
 * Artifact discovery for `ds_publish_version`. Extracted from
 * `ds-publish-version.ts` to keep that orchestration file focused (and under
 * the LOC cap). Reads the four optional artifact fields a published version can
 * carry, with hard size caps so a runaway build artifact can't blow up memory
 * or the DB row.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Max bytes we accept for a single text/JSON artifact persisted into the DB.
 * A runaway `docs.md`/`manifest.json` from the sandbox build would otherwise be
 * loaded whole into memory and stored verbatim, bloating the row. Stat-first so
 * an oversized file is never read into memory at all.
 */
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

/** Read a file only if it exists and is within the size cap; else null. */
async function readArtifactCapped(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size === 0 || st.size > MAX_ARTIFACT_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Best-effort discovery of the four optional artifact fields from the
 * package filesystem. All four are tried; whatever doesn't exist is
 * left as `null` so the caller's chain of fallbacks (explicit arg →
 * disk discovery → previous draft value) keeps working.
 *
 * - `docs_md`        → `pkg/docs.md` (the aggregated single-file docs).
 * - `storybook_path` → `pkg/storybook-static/` directory IF it has an
 *                       `index.html`. Stored as an absolute host path
 *                       so the proxy route (`/storybook/*`) can serve
 *                       files without further resolution.
 * - `manifest_json`  → `pkg/manifest.json` (component manifest).
 * - `mcp_manifest_json` → `pkg/mcp/manifest.json` (auto-MCP manifest).
 */
export async function discoverArtifacts(pkgDir: string, ctxCwd: string): Promise<{
  docs_md: string | null;
  storybook_path: string | null;
  manifest_json: string | null;
  mcp_manifest_json: string | null;
}> {
  const result = {
    docs_md: null as string | null,
    storybook_path: null as string | null,
    manifest_json: null as string | null,
    mcp_manifest_json: null as string | null,
  };
  void ctxCwd;

  // docs.md (text) — size-capped (oversized files are skipped, not stored).
  result.docs_md = await readArtifactCapped(join(pkgDir, 'docs.md'));

  // storybook-static/index.html — registers the directory
  try {
    const sbDir = join(pkgDir, 'storybook-static');
    const indexHtml = join(sbDir, 'index.html');
    await stat(indexHtml);
    result.storybook_path = sbDir;
  } catch { /* missing — keep null */ }

  // manifest.json (parse-validate before storing so a malformed file
  // doesn't poison the row — the dashboard expects valid JSON).
  const manifestBuf = await readArtifactCapped(join(pkgDir, 'manifest.json'));
  if (manifestBuf !== null) {
    try {
      JSON.parse(manifestBuf);
      result.manifest_json = manifestBuf;
    } catch { /* invalid JSON — keep null */ }
  }

  // mcp/manifest.json (same validation rule)
  const mcpManifestBuf = await readArtifactCapped(join(pkgDir, 'mcp', 'manifest.json'));
  if (mcpManifestBuf !== null) {
    try {
      JSON.parse(mcpManifestBuf);
      result.mcp_manifest_json = mcpManifestBuf;
    } catch { /* invalid JSON — keep null */ }
  }

  return result;
}
