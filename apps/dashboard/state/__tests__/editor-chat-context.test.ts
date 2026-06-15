import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatSelections,
  selectionId,
  useEditorChatContextStore,
  type CodeSelection,
} from '../editor-chat-context.js';

const PA = 1;
const PB = 2;

function refs(projectId: number): string[] {
  return useEditorChatContextStore.getState().byProject[projectId]?.fileRefs ?? [];
}
function sels(projectId: number): CodeSelection[] {
  return useEditorChatContextStore.getState().byProject[projectId]?.selections ?? [];
}

describe('editor-chat-context store', () => {
  beforeEach(() => {
    useEditorChatContextStore.setState({ byProject: {} });
  });

  it('adds, dedups and removes file refs per project', () => {
    const s = useEditorChatContextStore.getState();
    s.addFileRef(PA, 'src/a.ts');
    s.addFileRef(PA, 'src/a.ts'); // dup → no-op
    s.addFileRef(PA, 'src/b.ts');
    expect(refs(PA)).toEqual(['src/a.ts', 'src/b.ts']);

    s.removeFileRef(PA, 'src/a.ts');
    expect(refs(PA)).toEqual(['src/b.ts']);
  });

  it('keeps file refs isolated between projects', () => {
    const s = useEditorChatContextStore.getState();
    s.addFileRef(PA, 'src/a.ts');
    s.addFileRef(PB, 'src/z.ts');
    expect(refs(PA)).toEqual(['src/a.ts']);
    expect(refs(PB)).toEqual(['src/z.ts']);
  });

  it('toggles a file ref on and off', () => {
    const s = useEditorChatContextStore.getState();
    s.toggleFileRef(PA, 'src/a.ts');
    expect(refs(PA)).toEqual(['src/a.ts']);
    s.toggleFileRef(PA, 'src/a.ts');
    expect(refs(PA)).toEqual([]);
  });

  it('adds selections with a stable id and replaces the same range', () => {
    const s = useEditorChatContextStore.getState();
    s.addSelection(PA, { path: 'src/a.ts', startLine: 10, endLine: 20, text: 'first' });
    s.addSelection(PA, { path: 'src/a.ts', startLine: 10, endLine: 20, text: 'second' });
    expect(sels(PA)).toHaveLength(1);
    expect(sels(PA)[0].id).toBe(selectionId('src/a.ts', 10, 20));
    expect(sels(PA)[0].text).toBe('second');

    s.addSelection(PA, { path: 'src/a.ts', startLine: 30, endLine: 31, text: 'other' });
    expect(sels(PA)).toHaveLength(2);
  });

  it('caps selection text length', () => {
    const s = useEditorChatContextStore.getState();
    s.addSelection(PA, { path: 'src/a.ts', startLine: 1, endLine: 9999, text: 'x'.repeat(20_000) });
    expect(sels(PA)[0].text.length).toBe(8000);
  });

  it('removes a selection by id', () => {
    const s = useEditorChatContextStore.getState();
    s.addSelection(PA, { path: 'src/a.ts', startLine: 1, endLine: 2, text: 'a' });
    const id = sels(PA)[0].id;
    s.removeSelection(PA, id);
    expect(sels(PA)).toEqual([]);
  });

  it('clear() drops all staged context for the project only', () => {
    const s = useEditorChatContextStore.getState();
    s.addFileRef(PA, 'src/a.ts');
    s.addSelection(PA, { path: 'src/a.ts', startLine: 1, endLine: 2, text: 'a' });
    s.addFileRef(PB, 'src/z.ts');
    s.clear(PA);
    expect(refs(PA)).toEqual([]);
    expect(sels(PA)).toEqual([]);
    expect(refs(PB)).toEqual(['src/z.ts']);
  });
});

describe('formatSelections', () => {
  it('returns empty string for no selections', () => {
    expect(formatSelections([])).toBe('');
  });

  it('emits one <selected-code> block per selection with path + line range', () => {
    const out = formatSelections([
      { id: 'x', path: 'src/a.ts', startLine: 12, endLine: 20, text: 'const x = 1;' },
      { id: 'y', path: 'src/b.ts', startLine: 5, endLine: 5, text: 'foo()' },
    ]);
    expect(out).toBe(
      '<selected-code path="src/a.ts" lines="12-20">\nconst x = 1;\n</selected-code>\n' +
        '<selected-code path="src/b.ts" lines="5-5">\nfoo()\n</selected-code>',
    );
  });
});
