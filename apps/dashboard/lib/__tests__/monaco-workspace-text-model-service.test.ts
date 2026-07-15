import type * as MonacoNs from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceTextModelService } from '../monaco-workspace-text-model-service.js';

class FakeEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  readonly event = (listener: (event: T) => unknown): MonacoNs.IDisposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

describe('createWorkspaceTextModelService', () => {
  it('creates and disposes a reference for an existing Monaco model', async () => {
    const model = { isDisposed: () => false } as MonacoNs.editor.ITextModel;
    const monaco = {
      Emitter: FakeEmitter,
      editor: {
        getModel: vi.fn(() => model),
      },
    } as unknown as typeof MonacoNs;
    const service = createWorkspaceTextModelService(monaco);
    const reference = await service.createModelReference({ scheme: 'untitled' } as MonacoNs.Uri);
    const onWillDispose = vi.fn();

    reference.object.onWillDispose(onWillDispose);
    reference.dispose();

    expect(reference.object.textEditorModel).toBe(model);
    expect(onWillDispose).toHaveBeenCalledOnce();
  });
});
