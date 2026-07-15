export type SelectableChangeGroup = 'unstaged' | 'untracked';

export type ChangeSelectionState = 'none' | 'partial' | 'all';

export interface SelectableChange {
  path: string;
}

function selectionKey(group: SelectableChangeGroup, path: string): string {
  return `${group}\0${path}`;
}

export function isChangeSelected(
  group: SelectableChangeGroup,
  path: string,
  excluded: ReadonlySet<string>,
): boolean {
  return !excluded.has(selectionKey(group, path));
}

/**
 * Selection is represented as exclusions so newly discovered files are selected
 * by default without re-selecting files the user deliberately unchecked.
 */
export function selectedChangePaths(
  group: SelectableChangeGroup,
  files: readonly SelectableChange[],
  excluded: ReadonlySet<string>,
): string[] {
  return files
    .filter((file) => isChangeSelected(group, file.path, excluded))
    .map((file) => file.path);
}

export function changeSelectionState(
  group: SelectableChangeGroup,
  files: readonly SelectableChange[],
  excluded: ReadonlySet<string>,
): ChangeSelectionState {
  const selected = selectedChangePaths(group, files, excluded).length;
  if (selected === 0) return 'none';
  if (selected === files.length) return 'all';
  return 'partial';
}

export function toggleChangeSelection(
  group: SelectableChangeGroup,
  path: string,
  excluded: ReadonlySet<string>,
): Set<string> {
  const next = new Set(excluded);
  const key = selectionKey(group, path);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function toggleChangeGroupSelection(
  group: SelectableChangeGroup,
  files: readonly SelectableChange[],
  excluded: ReadonlySet<string>,
): Set<string> {
  const next = new Set(excluded);
  const selectAll = changeSelectionState(group, files, excluded) !== 'all';
  for (const file of files) {
    const key = selectionKey(group, file.path);
    if (selectAll) next.delete(key);
    else next.add(key);
  }
  return next;
}

export function pruneChangeSelection(
  groups: Record<SelectableChangeGroup, readonly SelectableChange[]>,
  excluded: ReadonlySet<string>,
): Set<string> {
  const validKeys = new Set<string>();
  for (const group of ['unstaged', 'untracked'] as const) {
    for (const file of groups[group]) validKeys.add(selectionKey(group, file.path));
  }
  return new Set([...excluded].filter((key) => validKeys.has(key)));
}
