/** Canonical project-relative folder roots. "." includes the project root. */
export function normalizeSemanticFolders(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Expected a list of project folders');
  const folders = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || entry.includes('\0')) {
      throw new Error('Invalid project folder');
    }
    const path = entry.replace(/\\/g, '/');
    const parts = path.split('/').filter((part) => part && part !== '.');
    if (path.startsWith('/') || /^[a-z]:/i.test(path) || parts.includes('..')) {
      throw new Error('Choose folders inside the project');
    }
    folders.add(parts.join('/') || '.');
  }
  if (folders.has('.')) return ['.'];
  return [...folders].sort().filter((folder) => {
    for (let i = folder.lastIndexOf('/'); i >= 0; i = folder.lastIndexOf('/', i - 1)) {
      if (folders.has(folder.slice(0, i))) return false;
    }
    return true;
  });
}

export function projectSemanticFolders(project: { semantic_index_folders?: string } | undefined): string[] {
  if (!project) return [];
  if (project.semantic_index_folders === undefined) return ['.'];
  try {
    return normalizeSemanticFolders(JSON.parse(project.semantic_index_folders));
  } catch {
    return [];
  }
}

export function isSemanticPath(folders: readonly string[], path: string): boolean {
  const relativePath = path.replace(/\\/g, '/');
  return folders.some((folder) => folder === '.' || relativePath.startsWith(folder + '/'));
}
