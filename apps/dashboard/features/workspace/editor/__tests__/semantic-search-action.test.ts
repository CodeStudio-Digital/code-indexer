import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSeStore } from '../../../search-everywhere/se-store.js';
import {
  registerSemanticSearchAction,
  semanticQueryFromEditor,
} from '../semantic-search-action.js';

function editorFixture(options: { selection?: string; word?: string; line?: string } = {}) {
  const selection = {
    isEmpty: () => !options.selection,
  };
  return {
    getModel: () => ({
      getValueInRange: () => options.selection ?? '',
      getWordAtPosition: () => options.word ? { word: options.word } : null,
      getLineContent: () => options.line ?? '',
    }),
    getSelection: () => selection,
    getPosition: () => ({ lineNumber: 4, column: 7 }),
  };
}

describe('semantic editor action', () => {
  beforeEach(() => useSeStore.setState({ open: false, initialQuery: null, tab: 'all' }));

  it('prefers the selected code and caps request text', () => {
    const editor = editorFixture({ selection: `  ${'x'.repeat(1_200)}  ` });
    expect(semanticQueryFromEditor(editor as never)).toHaveLength(1_000);
  });

  it('uses the word under the cursor without issuing a request on registration', async () => {
    let run: (() => void | Promise<void>) | undefined;
    const addAction = vi.fn((action: { run: () => void | Promise<void> }) => {
      run = action.run;
      return { dispose: vi.fn() };
    });
    const editor = { ...editorFixture({ word: 'LocalVectorRouter' }), addAction };

    registerSemanticSearchAction(editor as never);
    expect(useSeStore.getState().open).toBe(false);

    await run?.();
    expect(useSeStore.getState()).toMatchObject({
      open: true,
      tab: 'semantic',
      initialQuery: 'LocalVectorRouter',
    });
  });
});
