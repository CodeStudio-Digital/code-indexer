/**
 * Session overlay — in-memory tracker of files the agent has touched during
 * the current session (created/edited/written).
 *
 * The overlay is a simple Set of project-relative paths, normalized to forward
 * slashes. It carries no content or timestamps — the disk is always the source
 * of truth. When a tool reads a dirty file, the handler reads directly from
 * disk (via helpers in src/services/code-reader.ts) instead of hitting the
 * indexer DB.
 *
 * Scoped per runCoder() call; garbage-collected when the session finishes.
 */
export class SessionOverlay {
  private dirty = new Set<string>();

  constructor(public readonly projectRoot: string) {}

  /** Mark a file path as dirty (tocado nesta sessão). */
  mark(relPath: string): void {
    this.dirty.add(SessionOverlay.normalize(relPath));
  }

  /** True if the path has been touched in this session. */
  isDirty(relPath: string): boolean {
    return this.dirty.has(SessionOverlay.normalize(relPath));
  }

  /**
   * Return all dirty files, optionally filtered by path prefix.
   * Used by list_directory / grep_code handlers to merge overlay files
   * into the MCP server response.
   */
  filterDirty(prefix?: string): string[] {
    if (!prefix) return Array.from(this.dirty);
    const norm = SessionOverlay.normalize(prefix);
    const withSlash = norm.endsWith('/') ? norm : norm + '/';
    return Array.from(this.dirty).filter(
      (p) => p === norm || p.startsWith(withSlash)
    );
  }

  /** Number of tracked paths. */
  size(): number {
    return this.dirty.size;
  }

  /** Clear the overlay (e.g. after a manual re-index). */
  clear(): void {
    this.dirty.clear();
  }

  /**
   * Normalize a project-relative path: backslashes → forward slashes,
   * strip a leading "./". Does not touch absolute paths or ".." segments.
   */
  static normalize(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
  }
}
