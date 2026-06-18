/**
 * Copy manifest for the tiered-hybrid DB split (plan §8.4).
 *
 * Lists the project-scoped tables to move into a project's own DB, in
 * dependency order (parents before children). P2 ships the INDEX class only;
 * SESSION/SCOPE classes are added in P3. Every table here is filtered by a
 * direct `project_id` column. The copy engine tolerates a missing table/column
 * (partial schemas) the same way `projects.clearData` does.
 *
 * Because both DBs are built from the SAME schema (see project-schema.ts), the
 * copy is `INSERT INTO main.t SELECT <cols> FROM legacy.t WHERE project_id=?`
 * with identical column sets — `id` is preserved verbatim.
 */
export type SplitClass = 'INDEX' | 'SESSION' | 'SCOPE';

export interface ManifestEntry {
  table: string;
  cls: SplitClass;
  /** Direct project_id filter (the only kind in the INDEX class). */
  projectKey: 'project_id';
}

/** INDEX-class tables (P2). Order: parents before children (FK-safe even with FK on). */
export const INDEX_TABLES: ManifestEntry[] = [
  { table: 'files', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'symbols', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'symbol_references', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'symbol_relations', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'file_concepts', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'file_dependencies', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'file_snapshots', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'runs', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'costs', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'vector_ids', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'embedding_lsh_buckets', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'embedding_simhash_signatures', cls: 'INDEX', projectKey: 'project_id' },
  { table: 'webhooks', cls: 'INDEX', projectKey: 'project_id' },
];

/** The set of classes a given split run copies. P2 = INDEX only. */
export function manifestFor(classes: SplitClass[]): ManifestEntry[] {
  const all = [...INDEX_TABLES];
  return all.filter((e) => classes.includes(e.cls));
}
