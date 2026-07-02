import { describe, expect, it } from 'vitest';
import { EDIT_TOOLS, filesFromEditToolCall, isEditTool } from '../edit-tools.js';

describe('isEditTool', () => {
  it('matches the file-edit tools and nothing else', () => {
    for (const n of EDIT_TOOLS) expect(isEditTool(n)).toBe(true);
    expect(isEditTool('read_file')).toBe(false);
    expect(isEditTool('grep')).toBe(false);
    expect(isEditTool(undefined)).toBe(false);
    expect(isEditTool(null)).toBe(false);
  });
});

describe('filesFromEditToolCall', () => {
  it('edit_file / multi_edit / write_file → single edit ref from input.path', () => {
    expect(filesFromEditToolCall('edit_file', { path: 'src/a.ts' })).toEqual([
      { path: 'src/a.ts', op: 'edit' },
    ]);
    expect(filesFromEditToolCall('multi_edit', { path: 'src/b.ts', edits: [] })).toEqual([
      { path: 'src/b.ts', op: 'edit' },
    ]);
    expect(filesFromEditToolCall('write_file', { path: 'src/c.ts', content: 'x' })).toEqual([
      { path: 'src/c.ts', op: 'edit' },
    ]);
  });

  it('create_file → add op', () => {
    expect(filesFromEditToolCall('create_file', { path: 'src/new.ts', content: '' })).toEqual([
      { path: 'src/new.ts', op: 'add' },
    ]);
  });

  it('returns [] for missing path or non-edit tools', () => {
    expect(filesFromEditToolCall('edit_file', {})).toEqual([]);
    expect(filesFromEditToolCall('read_file', { path: 'x' })).toEqual([]);
    expect(filesFromEditToolCall('edit_file', null)).toEqual([]);
  });

  it('apply_patch → one ref per directive (add/update/delete)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+hello',
      '*** Update File: src/existing.ts',
      '@@',
      '-old',
      '+new',
      '*** Delete File: src/dead.ts',
      '*** End Patch',
    ].join('\n');
    expect(filesFromEditToolCall('apply_patch', { patch })).toEqual([
      { path: 'src/new.ts', op: 'add' },
      { path: 'src/existing.ts', op: 'edit' },
      { path: 'src/dead.ts', op: 'delete' },
    ]);
  });

  it('apply_patch → rename uses the move target path', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n');
    expect(filesFromEditToolCall('apply_patch', { patch })).toEqual([
      { path: 'src/renamed.ts', op: 'rename' },
    ]);
  });

  it('apply_patch → reads freeform text from input.input or a bare string field', () => {
    const patch = '*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch';
    expect(filesFromEditToolCall('apply_patch', { input: patch })).toEqual([
      { path: 'gone.ts', op: 'delete' },
    ]);
    expect(filesFromEditToolCall('apply_patch', { anything: patch })).toEqual([
      { path: 'gone.ts', op: 'delete' },
    ]);
  });

  it('apply_patch → [] when no patch text present', () => {
    expect(filesFromEditToolCall('apply_patch', { foo: 'bar' })).toEqual([]);
  });
});
