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
