/**
 * Inheritance-aware member/hierarchy walks over `symbol_relations`
 * (extends / implements / mixes — PHP traits land as 'mixes').
 *
 * Name-based like the rest of the structural graph: relations store the
 * RELATED NAME, so each hop re-resolves name → class symbol. Cycle-guarded
 * and depth-capped (deep chains beyond 5 hops add noise, not signal).
 *
 * Single source of truth: the get_hierarchy agent tool and the editor's
 * index fallback both call these.
 */
import type { DBSymbol } from '@mcp/shared/types.js';
import type { DB } from './types.js';
import { classMembers } from './symbols.js';
import { getRelations } from './symbol-relations.js';

const MAX_DEPTH = 5;
const PARENT_RELATIONS = new Set(['extends', 'implements', 'mixes']);

export interface DeepMember extends DBSymbol {
  /** Set when the member comes from an ancestor/trait rather than the class itself. */
  inherited_from?: string;
}

export interface DeepMembersResult {
  members: DeepMember[];
  /** Ancestors/traits actually visited, in walk order (BFS). */
  ancestry: string[];
}

/** Type-like symbol for a name — classes win over homonym methods/vars. */
function typeSymbol(db: DB, projectId: number, name: string): DBSymbol | undefined {
  return db.prepare(`
    SELECT * FROM symbols
    WHERE project_id = ? AND name = ?
      AND kind IN ('class', 'interface', 'trait', 'struct', 'enum', 'type')
    LIMIT 1
  `).get(projectId, name) as DBSymbol | undefined;
}

function parentNames(db: DB, projectId: number, className: string): string[] {
  const cls = typeSymbol(db, projectId, className);
  if (!cls) return [];
  return getRelations(db, cls.id)
    .filter((r) => PARENT_RELATIONS.has(r.relation_type))
    .map((r) => r.related_symbol_name);
}

/**
 * Members of a class INCLUDING inherited/trait members (BFS up the
 * relations). Overrides win: a name seen closer to the class shadows the
 * ancestor's copy. `includeInherited: false` degrades to the flat query.
 */
export function getClassMembersDeep(
  db: DB,
  projectId: number,
  className: string,
  includeInherited = true,
): DeepMembersResult {
  const members: DeepMember[] = classMembers(db, className, projectId);
  const ancestry: string[] = [];
  if (!includeInherited) return { members, ancestry };

  const seen = new Set(members.map((m) => m.name));
  const visited = new Set([className]);
  let frontier = parentNames(db, projectId, className);
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const parent of frontier) {
      if (visited.has(parent)) continue;
      visited.add(parent);
      ancestry.push(parent);
      for (const m of classMembers(db, parent, projectId)) {
        if (seen.has(m.name)) continue; // overridden closer to the class
        seen.add(m.name);
        members.push({ ...m, inherited_from: parent });
      }
      next.push(...parentNames(db, projectId, parent));
    }
    frontier = next;
  }
  return { members, ancestry };
}

/** Transitive `extends` chain (A → B → C), cycle-guarded, depth-capped. */
export function getExtendsChain(db: DB, projectId: number, className: string): string[] {
  const chain: string[] = [];
  const visited = new Set([className]);
  let current = className;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const cls = typeSymbol(db, projectId, current);
    if (!cls) break;
    const ext = getRelations(db, cls.id).find((r) => r.relation_type === 'extends');
    if (!ext || visited.has(ext.related_symbol_name)) break;
    chain.push(ext.related_symbol_name);
    visited.add(ext.related_symbol_name);
    current = ext.related_symbol_name;
  }
  return chain;
}
