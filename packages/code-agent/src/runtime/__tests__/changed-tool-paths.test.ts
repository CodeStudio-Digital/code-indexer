import { expect, it } from 'vitest';
import { changedToolPaths } from '../changed-tool-paths.js';

it('extracts every patch add/update/delete/move path without treating read inputs as mutations', () => {
  const patch = ['*** Begin Patch', '*** Add File: src/a.ts', '+export const a = 1;',
    '*** Update File: src/b.ts', '*** Move to: src/c.ts', '@@', '-old', '+new',
    '*** Delete File: src/d.ts', '*** End Patch'].join('\n');
  expect(changedToolPaths('apply_patch', { patch })).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  expect(changedToolPaths('apply_patch', { _raw: patch })).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  expect(changedToolPaths('apply_patch', { patch: 'invalid' })).toEqual([]);
  expect(changedToolPaths('read_file', { path: 'src/a.ts' })).toEqual([]);
  expect(changedToolPaths('manage_path', { from_path: 'a', to_path: 'b' })).toEqual(['a', 'b']);
  expect(changedToolPaths('multi_edit', { file_path: 'a' })).toEqual(['a']);
});
