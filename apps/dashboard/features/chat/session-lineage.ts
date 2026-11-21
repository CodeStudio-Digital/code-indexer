import type { CoderSession } from './types.js';

export interface SessionBranch {
  session: CoderSession;
  children: SessionBranch[];
}

export const SESSION_TREE_INDENT_LIMIT = 4;

export function groupSessionBranches(
  sessions: readonly CoderSession[],
  explicitGroup: (session: CoderSession) => string | undefined,
  fallbackGroup: string,
) {
  const nodes = new Map<string, SessionBranch>(sessions.map(session => [session.id, { session, children: [] }]));
  const placements = new Map<string, { group: string; parent?: SessionBranch }>();

  for (const session of sessions) {
    const path: SessionBranch[] = [];
    const visited = new Set<string>();
    let node = nodes.get(session.id);
    while (node && !placements.has(node.session.id) && !visited.has(node.session.id)) {
      visited.add(node.session.id);
      path.push(node);
      node = nodes.get(node.session.parent_session_id ?? '');
    }
    // Resolve the ancestor first. Missing or cyclic ancestry leaves a root.
    for (const { session: current } of path.reverse()) {
      const parentId = current.parent_session_id ?? '';
      const parentGroup = placements.get(parentId)?.group;
      const group = explicitGroup(current) ?? parentGroup ?? fallbackGroup;
      placements.set(current.id, { group, parent: parentGroup === group ? nodes.get(parentId) : undefined });
    }
  }

  const groups = new Map<string, { roots: SessionBranch[]; count: number }>();
  const parents = new Map<string, string>();
  for (const session of sessions) {
    const node = nodes.get(session.id)!;
    const { group, parent } = placements.get(session.id)!;
    const bucket = groups.get(group) ?? { roots: [], count: 0 };
    groups.set(group, bucket);
    bucket.count++;
    if (parent) {
      parent.children.push(node);
      parents.set(session.id, parent.session.id);
    } else {
      bucket.roots.push(node);
    }
  }
  return { groups, parents };
}

export function visibleSessionBranches(roots: SessionBranch[], collapsed: ReadonlySet<string>) {
  const rows: {
    branch: SessionBranch;
    depth: number;
    ancestorGuides: readonly number[];
    hasNextSibling: boolean;
  }[] = [];
  const visit = (branches: SessionBranch[], depth: number, ancestorGuides: readonly number[]) => {
    branches.forEach((branch, index) => {
      const hasNextSibling = index < branches.length - 1;
      rows.push({ branch, depth, ancestorGuides, hasNextSibling });
      if (collapsed.has(branch.session.id) || !branch.children.length) return;
      // Keep the parent's guide through descendants when another sibling follows.
      const childGuides = hasNextSibling && depth > 0 && depth < SESSION_TREE_INDENT_LIMIT
        ? [...ancestorGuides, depth - 1]
        : ancestorGuides;
      visit(branch.children, depth + 1, childGuides);
    });
  };
  visit(roots, 0, []);
  return rows;
}
