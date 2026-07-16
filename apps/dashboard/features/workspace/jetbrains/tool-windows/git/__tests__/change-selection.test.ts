import { describe, expect, it } from 'vitest';
import {
  changeSelectionState,
  isChangeSelected,
  pruneChangeSelection,
  selectedChangePaths,
  toggleChangeGroupSelection,
  toggleChangeSelection,
} from '../change-selection.js';

const files = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }];

describe('Git change selection', () => {
  it('selects every discovered file by default', () => {
    const excluded = new Set<string>();

    expect(selectedChangePaths('staged', files, excluded)).toEqual(files.map((file) => file.path));
    expect(changeSelectionState('staged', files, excluded)).toBe('all');
    expect(selectedChangePaths('unstaged', files, excluded)).toEqual(files.map((file) => file.path));
    expect(changeSelectionState('unstaged', files, excluded)).toBe('all');
  });

  it('keeps unchecked files out of the bulk action and exposes the partial state', () => {
    const excluded = toggleChangeSelection('unstaged', 'src/b.ts', new Set());

    expect(isChangeSelected('unstaged', 'src/b.ts', excluded)).toBe(false);
    expect(selectedChangePaths('unstaged', files, excluded)).toEqual(['src/a.ts', 'src/c.ts']);
    expect(changeSelectionState('unstaged', files, excluded)).toBe('partial');
  });

  it('toggles the section checkbox between none and all', () => {
    const noneSelected = toggleChangeGroupSelection('untracked', files, new Set());
    expect(changeSelectionState('untracked', files, noneSelected)).toBe('none');

    const allSelected = toggleChangeGroupSelection('untracked', files, noneSelected);
    expect(changeSelectionState('untracked', files, allSelected)).toBe('all');
    expect(selectedChangePaths('untracked', files, allSelected)).toEqual(files.map((file) => file.path));
  });

  it('selects all from a partial section state', () => {
    const partial = toggleChangeSelection('unstaged', 'src/a.ts', new Set());
    const allSelected = toggleChangeGroupSelection('unstaged', files, partial);

    expect(changeSelectionState('unstaged', files, allSelected)).toBe('all');
  });

  it('drops stale exclusions while preserving unchecked files still on screen', () => {
    let excluded = toggleChangeSelection('unstaged', 'src/a.ts', new Set());
    excluded = toggleChangeSelection('untracked', 'old.txt', excluded);

    const pruned = pruneChangeSelection(
      { staged: [{ path: 'staged.ts' }], unstaged: files, untracked: [{ path: 'new.txt' }] },
      excluded,
    );

    expect(isChangeSelected('unstaged', 'src/a.ts', pruned)).toBe(false);
    expect(isChangeSelected('untracked', 'old.txt', pruned)).toBe(true);
    expect(pruned.size).toBe(1);
  });

  it('keeps staged selection independent from the same unstaged path', () => {
    const excluded = toggleChangeSelection('staged', 'src/a.ts', new Set());

    expect(isChangeSelected('staged', 'src/a.ts', excluded)).toBe(false);
    expect(isChangeSelected('unstaged', 'src/a.ts', excluded)).toBe(true);
  });
});
