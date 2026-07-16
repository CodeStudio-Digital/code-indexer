/**
 * Canonical vector-store namespaces.
 *
 * Code is isolated PER PROJECT; docs PER COLLECTION (docs are cross-project by
 * design — a collection like "unity-docs" is shared across game projects, so
 * the collection, not the project, is the isolation axis).
 *
 * Namespace identity is always based on durable numeric ids. Project names are
 * presentation data: renaming a project must not move or invalidate vectors.
 */

/**
 * Namespace for a project's code and symbol vectors.
 */
export function codeNamespace(projectId: number): string {
  return `code:p${projectId}`;
}

/** Namespace for a documentation collection's chunk vectors. */
export function docNamespace(collectionId: number | string): string {
  return `docs:c${collectionId}`;
}

/** Snapshots are project-owned, but use an independent generation/table. */
export function snapshotNamespace(projectId: number): string {
  return `snapshot:p${projectId}`;
}

/** Durable project-memory namespace. */
export function projectMemoryNamespace(projectId: number): string {
  return `memory:project:p${projectId}`;
}

/** Global user memory lives in its own physical database. */
export function userMemoryNamespace(): 'memory:user' {
  return 'memory:user';
}

export function isCodeNamespace(ns: string): boolean {
  return ns.startsWith('code:');
}

export function isDocNamespace(ns: string): boolean {
  return ns.startsWith('docs:');
}

export function isSnapshotNamespace(ns: string): boolean {
  return ns.startsWith('snapshot:');
}

export function isMemoryNamespace(ns: string): boolean {
  return ns.startsWith('memory:');
}

/**
 * Sanitize a namespace into a token safe for backends that name a physical
 * object after it (for example a local sqlite-vec table): only [A-Za-z0-9_].
 */
export function namespaceToken(ns: string): string {
  return ns.replace(/[^A-Za-z0-9]+/g, '_');
}
