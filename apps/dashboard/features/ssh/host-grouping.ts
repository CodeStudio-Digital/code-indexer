/**
 * Host rail filtering + grouping, pulled out of SshPanel.tsx (633 lines) so it
 * is memoizable and testable. It used to run in the render body on every
 * render — rebuilding the filter and the group Map once per keystroke in the
 * search box, and again on every progress frame while a transfer streamed.
 *
 * Grouping rules: hosts shared across all projects get a pinned group at the
 * top (they aren't "this project's", so burying them among the local groups
 * hides the ones with the widest blast radius); the rest group by `group_name`,
 * with ungrouped sorted last.
 */
import type { SshHost } from './types.js';

/** Leading space keeps these sentinels out of collation with real group names. */
export const UNGROUPED = ' ungrouped';
export const SHARED = ' shared';

interface HostGroups {
  groups: Map<string, SshHost[]>;
  /** Display order: SHARED first (when non-empty), then named groups, UNGROUPED last. */
  groupKeys: string[];
}

/** Free-text match over label / hostname / username / group / tags. */
function matches(h: SshHost, q: string): boolean {
  return [h.label, h.hostname, h.username, h.group_name ?? '', h.tags_json]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

export function groupHosts(hosts: SshHost[], query: string): HostGroups {
  const q = query.trim().toLowerCase();
  const filtered = q ? hosts.filter((h) => matches(h, q)) : hosts;

  const groups = new Map<string, SshHost[]>();
  const shared: SshHost[] = [];
  for (const h of filtered) {
    if (h.is_shared) {
      shared.push(h);
      continue;
    }
    const key = h.group_name?.trim() || UNGROUPED;
    const bucket = groups.get(key);
    if (bucket) bucket.push(h);
    else groups.set(key, [h]);
  }
  if (shared.length > 0) groups.set(SHARED, shared);

  const named = [...groups.keys()]
    .filter((k) => k !== SHARED)
    .sort((a, b) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)));

  return { groups, groupKeys: shared.length > 0 ? [SHARED, ...named] : named };
}
