/** Deterministic, filesystem-safe folder name for a linked project. */
export function workspaceSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() || 'project';
}

/**
 * Assign collision-safe slugs in input order. Callers must pass projects in
 * their canonical order (primary first, then project id) so the physical
 * workspace, scanner, and prompt all address the same folders.
 */
export function assignWorkspaceSlugs<T extends { name: string }>(
  projects: readonly T[],
): Array<T & { slug: string }> {
  const used = new Set<string>();
  return projects.map((project) => {
    const base = workspaceSlug(project.name);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}_${n++}`;
    used.add(slug);
    return { ...project, slug };
  });
}
