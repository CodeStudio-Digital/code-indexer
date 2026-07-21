import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MonacoNs from 'monaco-editor';
import { useWorkspaceStore, type OpenFile } from '../../../../state/workspace.js';
import {
  EDITOR_CONTENT_MIRROR_DELAY_MS,
  flushEditorContentMirror,
  recordEditorContentChange,
} from '../editor-models.js';

function seedFile(): void {
  useWorkspaceStore.setState({
    activeProjectId: 7,
    activeFilePath: 'src/large.ts',
    openFiles: [{
      kind: 'file',
      projectId: 7,
      path: 'src/large.ts',
      content: 'disk snapshot',
      dirty: false,
      lastModified: 'before',
    }],
    panes: [{ id: 'pane', order: ['src/large.ts'], activePath: 'src/large.ts' }],
    activePaneId: 'pane',
    splitDir: null,
  });
}

function fakeModel(value: { current: string }) {
  const getValue = vi.fn(() => value.current);
  const model = {
    uri: { path: '/p7/src/large.ts' },
    getValue,
    isDisposed: () => false,
  } as unknown as MonacoNs.editor.ITextModel;
  return { model, getValue };
}

describe('debounced Monaco content mirror', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    seedFile();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('marks dirty without reading the full model and mirrors only after idle', () => {
    const value = { current: 'first edit' };
    const { model, getValue } = fakeModel(value);

    recordEditorContentChange(model);
    let file = useWorkspaceStore.getState().openFiles[0] as OpenFile;
    expect(file.dirty).toBe(true);
    expect(file.content).toBe('disk snapshot');
    expect(getValue).not.toHaveBeenCalled();

    value.current = 'latest edit';
    recordEditorContentChange(model);
    vi.advanceTimersByTime(EDITOR_CONTENT_MIRROR_DELAY_MS - 1);
    expect(getValue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    file = useWorkspaceStore.getState().openFiles[0] as OpenFile;
    expect(getValue).toHaveBeenCalledOnce();
    expect(file.content).toBe('latest edit');
    expect(file.dirty).toBe(true);
  });

  it('does not re-dirty a file when a trailing mirror lands after save', () => {
    const value = { current: 'saved model' };
    const { model } = fakeModel(value);

    recordEditorContentChange(model);
    useWorkspaceStore.getState().markClean(7, 'src/large.ts', 'after');
    vi.advanceTimersByTime(EDITOR_CONTENT_MIRROR_DELAY_MS);

    const file = useWorkspaceStore.getState().openFiles[0] as OpenFile;
    expect(file.content).toBe('saved model');
    expect(file.dirty).toBe(false);
    expect(file.lastModified).toBe('after');
  });

  it('flushes the pending fallback mirror before a model is released', () => {
    const value = { current: 'tab switch snapshot' };
    const { model, getValue } = fakeModel(value);

    recordEditorContentChange(model);
    flushEditorContentMirror(model);

    expect(getValue).toHaveBeenCalledOnce();
    expect((useWorkspaceStore.getState().openFiles[0] as OpenFile).content).toBe('tab switch snapshot');
    vi.advanceTimersByTime(EDITOR_CONTENT_MIRROR_DELAY_MS);
    expect(getValue).toHaveBeenCalledOnce();
  });
});
