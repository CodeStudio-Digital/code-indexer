import type { AppWorkItem } from './types.js';

function scopesConflict(a: AppWorkItem, b: AppWorkItem): boolean {
  if (a.file_scope.length === 0 || b.file_scope.length === 0) return a.kind === 'implement' && b.kind === 'implement';
  return a.file_scope.some((left) => b.file_scope.some((right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
}

export interface AppDispatchItem {
  work_item_id: string;
  mode: 'inline' | 'subagent';
  profile: string;
}

export function planAdaptiveDispatch(items: AppWorkItem[]): AppDispatchItem[][] {
  const done = new Set(items.filter((item) => item.status === 'done').map((item) => item.id));
  const review = new Set(items.filter((item) => item.status === 'review').map((item) => item.id));
  const candidates = items
    .filter((item) => item.status === 'ready' && item.depends_on.every((dependency) => done.has(dependency) || (item.kind === 'verify' && review.has(dependency))))
    .sort((a, b) => a.priority - b.priority || a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  const waves: AppWorkItem[][] = [];
  for (const item of candidates) {
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((peer) => scopesConflict(item, peer))) {
        wave.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([item]);
  }
  return waves.map((wave) => wave.map((item) => ({
    work_item_id: item.id,
    mode: item.kind === 'change' || (item.kind === 'plan' && item.file_scope.length === 0) ? 'inline' : 'subagent',
    profile: item.owner_profile,
  })));
}

export function staleWorkItemsBySources(items: AppWorkItem[], changedSourceIds: string[]): Set<string> {
  const matches = (source: string): boolean => changedSourceIds.some((selector) => selector.endsWith('*') ? source.startsWith(selector.slice(0, -1)) : source === selector);
  const stale = new Set(items.filter((item) => item.source_ids.some(matches)).map((item) => item.id));
  return dependentWorkItemIds(items, stale);
}

export function dependentWorkItemIds(items: AppWorkItem[], seedIds: Iterable<string>): Set<string> {
  const affected = new Set(seedIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of items) {
      if (!affected.has(item.id) && item.depends_on.some((dependency) => affected.has(dependency))) {
        affected.add(item.id);
        expanded = true;
      }
    }
  }
  return affected;
}
