import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiCall, getActiveEditor, showPopup } = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getActiveEditor: vi.fn(),
  showPopup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../../lib/api-client.js', () => ({ apiCall }));
vi.mock('../../editor-models.js', () => ({ getActiveEditor }));
vi.mock('../symbol-navigation-popup.js', () => ({ showSymbolNavigationPopup: showPopup }));

import {
  __resetSymbolNavigationCacheForTests,
  attachSymbolNavigationGutter,
  documentSymbolsForModel,
  registerSymbolNavigationCodeLensProvider,
} from '../symbol-navigation-ui.js';
import { __emitLspServerReadyForTests } from '../server-ready.js';

class FakeEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

function fakeModel() {
  const lines = new Map([
    [4, 'class Example {'],
    [8, '  public function run(): void {'],
  ]);
  return {
    uri: { path: '/p7/src/Example.php', toString: () => 'file:///p7/src/Example.php' },
    getVersionId: () => 1,
    getLanguageId: () => 'php',
    getLineCount: () => 20,
    getLineContent: (line: number) => lines.get(line) ?? '',
    isDisposed: () => false,
  };
}

describe('symbol navigation Code Vision', () => {
  beforeEach(() => {
    apiCall.mockReset();
    getActiveEditor.mockReset();
    showPopup.mockClear();
    __resetSymbolNavigationCacheForTests();
    const symbols = [
      {
        name: 'Example', kind: 'class',
        range: { start: { line: 4, column: 1 }, end: { line: 20, column: 2 } },
        // Mirrors PHP servers that report the whole declaration line rather
        // than the identifier; the UI must tighten this to column 7.
        selectionRange: { start: { line: 4, column: 1 }, end: { line: 4, column: 15 } },
        children: [{
          name: 'run', kind: 'method',
          range: { start: { line: 8, column: 3 }, end: { line: 12, column: 4 } },
          selectionRange: { start: { line: 8, column: 19 }, end: { line: 8, column: 22 } },
        }],
      },
    ];
    apiCall.mockImplementation((method: string) => method === 'lsp.documentSymbols'
      ? Promise.resolve(symbols)
      : Promise.resolve([{ file: 'D:/project/src/Consumer.php', range: {
        start: { line: 3, column: 8 }, end: { line: 3, column: 15 },
      } }]));
  });

  it('shares one symbol request and exposes usages/implementations above declarations', async () => {
    let provider: { provideCodeLenses: Function } | undefined;
    const commands = new Map<string, Function>();
    class Range {
      constructor(
        public startLineNumber: number, public startColumn: number,
        public endLineNumber: number, public endColumn: number,
      ) {}
    }
    const monaco = {
      Emitter: FakeEmitter,
      Range,
      Uri: { file: (path: string) => ({ scheme: 'file', path, toString: () => `file:///${path}` }) },
      languages: {
        registerCodeLensProvider: (_language: string, value: typeof provider) => {
          provider = value; return { dispose() {} };
        },
      },
      editor: {
        registerCommand: (id: string, handler: Function) => {
          commands.set(id, handler); return { dispose() {} };
        },
      },
    } as never;
    const model = fakeModel();

    await Promise.all([
      documentSymbolsForModel(model as never, 7),
      documentSymbolsForModel(model as never, 7),
    ]);
    const handles = registerSymbolNavigationCodeLensProvider(monaco, 7);
    const list = await provider!.provideCodeLenses(model, { isCancellationRequested: false });

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(list.lenses.map((lens: { command: { title: string } }) => lens.command.title))
      .toEqual(['Mostrar usos', 'Mostrar implementações', 'Mostrar usos']);

    const editor = {
      getModel: () => model,
      setPosition: vi.fn(), revealPositionInCenterIfOutsideViewport: vi.fn(),
      focus: vi.fn(), trigger: vi.fn(),
    };
    getActiveEditor.mockReturnValue(editor);
    const usagesLens = list.lenses[0];
    expect(usagesLens.command.arguments[0].position).toEqual({ line: 4, column: 7 });
    commands.get(usagesLens.command.id)!({}, usagesLens.command.arguments[0]);
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 4, column: 7 });
    await vi.waitFor(() => expect(showPopup).toHaveBeenCalledTimes(1));

    const implementationLens = list.lenses[1];
    commands.get(implementationLens.command.id)!({}, implementationLens.command.arguments[0]);
    await vi.waitFor(() => expect(showPopup).toHaveBeenCalledTimes(2));
    handles.forEach((handle) => handle.dispose());
  });

  it('retries a cold empty symbol result and invalidates CodeLens when the server becomes ready', async () => {
    let provider: {
      onDidChange?: (listener: () => void) => { dispose(): void };
      provideCodeLenses: Function;
    } | undefined;
    class Range {
      constructor(
        public startLineNumber: number, public startColumn: number,
        public endLineNumber: number, public endColumn: number,
      ) {}
    }
    const monaco = {
      Emitter: FakeEmitter,
      Range,
      Uri: { file: (path: string) => ({ scheme: 'file', path, toString: () => `file:///${path}` }) },
      languages: {
        registerCodeLensProvider: (_language: string, value: typeof provider) => {
          provider = value; return { dispose() {} };
        },
      },
      editor: {
        getEditors: () => [],
        registerCommand: () => ({ dispose() {} }),
      },
    } as never;
    const model = fakeModel();
    const symbols = [{
      name: 'Example', kind: 'class',
      range: { start: { line: 4, column: 1 }, end: { line: 20, column: 2 } },
      selectionRange: { start: { line: 4, column: 7 }, end: { line: 4, column: 14 } },
    }];
    apiCall.mockResolvedValueOnce([]).mockResolvedValueOnce(symbols);

    const handles = registerSymbolNavigationCodeLensProvider(monaco, 7);
    const changed = vi.fn();
    const changedHandle = provider!.onDidChange!(changed);
    const cold = await provider!.provideCodeLenses(model, { isCancellationRequested: false });
    expect(cold.lenses).toEqual([]);

    __emitLspServerReadyForTests(7);
    expect(changed).toHaveBeenCalledOnce();
    const ready = await provider!.provideCodeLenses(model, { isCancellationRequested: false });
    expect(ready.lenses).toHaveLength(2);
    expect(apiCall).toHaveBeenCalledTimes(2);

    changedHandle.dispose();
    handles.forEach((handle) => handle.dispose());
  });

  it('turns Ctrl+click on a declaration into the usages command', async () => {
    let mouseHandler: ((event: any) => void) | undefined;
    const setDecorations = vi.fn();
    class Range {
      constructor(
        public startLineNumber: number, public startColumn: number,
        public endLineNumber: number, public endColumn: number,
      ) {}
    }
    const monaco = {
      Range,
      editor: {
        GlyphMarginLane: { Right: 2 },
        MouseTargetType: { CONTENT_TEXT: 6, GUTTER_GLYPH_MARGIN: 2 },
        TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
      },
    } as never;
    const model = {
      ...fakeModel(),
      onDidChangeContent: () => ({ dispose() {} }),
    };
    const editor = {
      getModel: () => model,
      createDecorationsCollection: () => ({ set: setDecorations, clear: vi.fn() }),
      getDomNode: () => null,
      getScrollTop: () => 0,
      onMouseDown: (handler: typeof mouseHandler) => {
        mouseHandler = handler; return { dispose() {} };
      },
      setPosition: vi.fn(),
      revealPositionInCenterIfOutsideViewport: vi.fn(),
      focus: vi.fn(),
      trigger: vi.fn(),
    };

    const handle = attachSymbolNavigationGutter(editor as never, monaco, 7);
    await vi.waitFor(() => expect(setDecorations).toHaveBeenCalled());
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    mouseHandler!({
      event: { leftButton: true, ctrlKey: true, metaKey: false, preventDefault, stopPropagation },
      target: { type: 6, position: { lineNumber: 4, column: 9 } },
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(showPopup).toHaveBeenCalledOnce());
    expect(showPopup).toHaveBeenCalledWith(
      editor, monaco, 7, { line: 4, column: 7 }, expect.any(Array), 'Usos de Example',
    );
    handle.dispose();
  });
});
