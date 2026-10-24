import type { DB } from './types.js';

export interface TypePage { offset: number; limit: number; declarationLine?: number }
export interface TypeDefinition { id: number; name: string; kind: string; file_path: string; line: number | null; namespace: string | null; stable_id: string | null }
export interface TypeEdge { direction: 'parent' | 'child'; relation: string; name: string; kind: string | null; file_path: string | null; line: number | null; namespace: string | null }
const columns = 's.id, s.name, s.kind, s.file_path, s.line, s.namespace, s.stable_id';
const typeKinds = "('class','interface','trait','struct','enum','type')";
function validate(page: TypePage) {
  if (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit)
    || page.limit < 1 || page.limit > 500) throw new Error('Invalid type page');
  if (page.declarationLine != null && (!Number.isSafeInteger(page.declarationLine) || page.declarationLine < 1)) throw new Error('Invalid declaration line');
}
function count(db: DB, sql: string, args: Array<string | number>) {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}
function definitionPage(db: DB, projectId: number, name: string, path: string | undefined, page: TypePage) {
  const where = `s.project_id=? AND s.name=? AND s.kind IN ${typeKinds}` + (path ? ' AND s.file_path=?' : '')
    + (page.declarationLine == null ? '' : ' AND s.line=?');
  const args = path ? [projectId, name, path] : [projectId, name];
  if (page.declarationLine != null) args.push(page.declarationLine);
  const total = count(db, 'SELECT COUNT(*) AS n FROM symbols s WHERE ' + where, args);
  const items = db.prepare('SELECT ' + columns + ' FROM symbols s WHERE ' + where + ' ORDER BY s.file_path, s.line, s.id LIMIT ? OFFSET ?')
    .all(...args, page.limit, page.offset) as TypeDefinition[];
  return { total, items };
}

/** Name-based index edges, deliberately not advertised as compiler type resolution. */
export function implementationsPage(db: DB, projectId: number, name: string, page: TypePage) {
  validate(page);
  return db.transaction(() => {
    const where = `s.project_id=? AND EXISTS (SELECT 1 FROM symbol_relations r WHERE r.project_id=s.project_id
      AND r.symbol_id=s.id AND r.related_symbol_name=? AND r.relation_type='implements')`;
    const total = count(db, 'SELECT COUNT(*) AS n FROM symbols s WHERE ' + where, [projectId, name]);
    const items = db.prepare('SELECT ' + columns + ' FROM symbols s WHERE ' + where + ' ORDER BY s.name, s.file_path, s.line, s.id LIMIT ? OFFSET ?')
      .all(projectId, name, page.limit, page.offset) as TypeDefinition[];
    return { total, items, offset: page.offset };
  })();
}

export function hierarchyPage(db: DB, projectId: number, name: string, path: string | undefined, page: TypePage) {
  validate(page);
  return db.transaction(() => {
    // A separate small selection resolves the root; offset only affects the
    // displayed candidates/edges, never which definition is chosen.
    const root = definitionPage(db, projectId, name, path, { offset: 0, limit: 2, declarationLine: page.declarationLine });
    if (root.total > 1) return { ambiguous: true as const, ...definitionPage(db, projectId, name, path, page), offset: page.offset };
    const symbol = root.items[0];
    if (path && !symbol) throw new Error('[SYMBOL_NOT_FOUND] No indexed type with this name in the requested file');
    const query = `SELECT DISTINCT 'parent' AS direction, r.relation_type AS relation, r.related_symbol_name AS name,
      NULL AS kind, NULL AS file_path, NULL AS line, NULL AS namespace FROM symbol_relations r
      WHERE r.project_id=? AND r.symbol_id=? AND r.relation_type IN ('extends','implements','mixes')
      UNION SELECT 'child', r.relation_type, s.name, s.kind, s.file_path, s.line, s.namespace
      FROM symbol_relations r JOIN symbols s ON s.id=r.symbol_id AND s.project_id=r.project_id
      WHERE r.project_id=? AND r.related_symbol_name=? AND r.relation_type IN ('extends','implements','mixes')`;
    const args = [projectId, symbol?.id ?? -1, projectId, name];
    const total = count(db, 'SELECT COUNT(*) AS n FROM (' + query + ')', args);
    const items = db.prepare('SELECT * FROM (' + query + ') ORDER BY direction, relation, name, file_path, line LIMIT ? OFFSET ?')
      .all(...args, page.limit, page.offset) as TypeEdge[];
    const chain: string[] = [], visited = new Set([name]);
    let current = symbol, chainStop: 'complete' | 'cycle' | 'depth_limit' | 'ambiguous' | 'unindexed' | 'branching' = 'complete';
    while (current) {
      const parents = db.prepare("SELECT DISTINCT related_symbol_name AS name FROM symbol_relations WHERE project_id=? AND symbol_id=? AND relation_type='extends' ORDER BY name LIMIT 2")
        .all(projectId, current.id) as Array<{ name: string }>;
      if (!parents.length) break;
      if (chain.length === 5) { chainStop = 'depth_limit'; break; }
      if (parents.length > 1) { chainStop = 'branching'; break; }
      const parent = parents[0].name;
      if (visited.has(parent)) { chainStop = 'cycle'; break; }
      visited.add(parent); chain.push(parent);
      const next = definitionPage(db, projectId, parent, undefined, { offset: 0, limit: 2 });
      if (next.total > 1) { chainStop = 'ambiguous'; break; }
      if (!next.total) { chainStop = 'unindexed'; break; }
      current = next.items[0];
    }
    return { ambiguous: false as const, symbol, total, items, offset: page.offset, extends_chain: chain, chain_stop: chainStop };
  })();
}
