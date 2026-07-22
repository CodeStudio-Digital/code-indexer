import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiCall } = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock('../../../../../lib/api-client.js', () => ({ apiCall }));

import { registerAdvancedLanguageFeatureProviders } from '../advancedLanguageFeatures.js';

interface CapturedProviders {
  typeDefinition?: { provideTypeDefinition: Function };
  folding?: { provideFoldingRanges: Function };
  inlay?: { provideInlayHints: Function };
  linked?: { provideLinkedEditingRanges: Function };
}

class Range {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}

function harness() {
  const providers: CapturedProviders = {};
  const disposable = () => ({ dispose: vi.fn() });
  const monaco = {
    Range,
    Uri: { file: (path: string) => ({ path }) },
    languages: {
      FoldingRangeKind: { fromValue: (value: string) => ({ value }) },
      registerTypeDefinitionProvider: (_selector: string, provider: unknown) => {
        providers.typeDefinition = provider as CapturedProviders['typeDefinition'];
        return disposable();
      },
      registerFoldingRangeProvider: (_selector: string, provider: unknown) => {
        providers.folding = provider as CapturedProviders['folding'];
        return disposable();
      },
      registerInlayHintsProvider: (_selector: string, provider: unknown) => {
        providers.inlay = provider as CapturedProviders['inlay'];
        return disposable();
      },
      registerLinkedEditingRangeProvider: (_selector: string, provider: unknown) => {
        providers.linked = provider as CapturedProviders['linked'];
        return disposable();
      },
    },
  } as never;
  const ensureSynced = vi.fn(async () => undefined);
  const disposers = registerAdvancedLanguageFeatureProviders(monaco, 7, ensureSynced);
  return { providers, ensureSynced, disposers };
}

function model(projectId = 7) {
  return {
    uri: { path: `/p${projectId}/src/app.component.html` },
    getVersionId: () => 4,
    isDisposed: () => false,
  };
}

function cancellationToken() {
  let listener: (() => void) | undefined;
  return {
    token: {
      isCancellationRequested: false,
      onCancellationRequested(callback: () => void) {
        listener = callback;
        return { dispose: () => { listener = undefined; } };
      },
    },
    cancel() {
      this.token.isCancellationRequested = true;
      listener?.();
    },
  };
}

describe('advanced Monaco language feature providers', () => {
  beforeEach(() => {
    apiCall.mockReset();
  });

  it('maps all public 1-based DTOs without losing rich inlay data', async () => {
    const { providers, ensureSynced, disposers } = harness();
    const activeModel = model();
    const token = cancellationToken().token;
    apiCall.mockImplementation((operation: string) => {
      switch (operation) {
        case 'lsp.typeDefinition':
          return Promise.resolve([{
            file: 'D:/repo/src/user.ts',
            range: { start: { line: 8, column: 3 }, end: { line: 8, column: 7 } },
          }]);
        case 'lsp.foldingRanges':
          return Promise.resolve([{ startLine: 2, endLine: 9, kind: 'region' }]);
        case 'lsp.inlayHints':
          return Promise.resolve([{
            position: { line: 6, column: 12 },
            label: [{
              label: 'value:',
              tooltip: 'parameter',
              command: { title: 'Open', command: 'editor.action.revealDefinition', arguments: [1] },
              location: {
                file: 'D:/repo/src/input.ts',
                range: { start: { line: 3, column: 2 }, end: { line: 3, column: 8 } },
              },
            }],
            kind: 2,
            tooltip: 'hint',
            textEdits: [{
              range: { start: { line: 6, column: 12 }, end: { line: 6, column: 12 } },
              newText: 'value: ',
            }],
            paddingRight: true,
          }]);
        case 'lsp.linkedEditingRanges':
          return Promise.resolve({
            ranges: [
              { start: { line: 1, column: 2 }, end: { line: 1, column: 8 } },
              { start: { line: 4, column: 3 }, end: { line: 4, column: 9 } },
            ],
            wordPattern: '[A-Za-z][A-Za-z0-9-]*',
          });
        default:
          throw new Error(`unexpected operation ${operation}`);
      }
    });

    const definitions = await providers.typeDefinition!.provideTypeDefinition(
      activeModel, { lineNumber: 5, column: 4 }, token,
    );
    expect(definitions).toEqual([{
      uri: { path: 'D:/repo/src/user.ts' },
      range: new Range(8, 3, 8, 7),
    }]);

    const folds = await providers.folding!.provideFoldingRanges(activeModel, {}, token);
    expect(folds).toEqual([{ start: 2, end: 9, kind: { value: 'region' } }]);

    const inlayList = await providers.inlay!.provideInlayHints(
      activeModel, new Range(5, 1, 10, 20), token,
    );
    expect(inlayList.hints).toEqual([expect.objectContaining({
      position: { lineNumber: 6, column: 12 },
      kind: 2,
      tooltip: 'hint',
      paddingRight: true,
      label: [expect.objectContaining({
        label: 'value:',
        command: { id: 'editor.action.revealDefinition', title: 'Open', arguments: [1] },
        location: { uri: { path: 'D:/repo/src/input.ts' }, range: new Range(3, 2, 3, 8) },
      })],
      textEdits: [{ range: new Range(6, 12, 6, 12), text: 'value: ' }],
    })]);

    const linked = await providers.linked!.provideLinkedEditingRanges(
      activeModel, { lineNumber: 1, column: 4 }, token,
    );
    expect(linked.ranges).toEqual([new Range(1, 2, 1, 8), new Range(4, 3, 4, 9)]);
    expect(linked.wordPattern.test('app-title')).toBe(true);

    expect(apiCall).toHaveBeenCalledWith('lsp.inlayHints', {
      projectId: 7,
      file: 'src/app.component.html',
      range: { start: { line: 5, column: 1 }, end: { line: 10, column: 20 } },
    }, { signal: expect.any(AbortSignal) });
    expect(ensureSynced).toHaveBeenCalledTimes(4);
    expect(disposers).toHaveLength(4);

    expect(inlayList.hints).toHaveLength(1);
    inlayList.dispose();
    expect(inlayList.hints).toHaveLength(0);
  });

  it('propagates Monaco cancellation to the HTTP request and returns an empty result', async () => {
    const { providers } = harness();
    const cancellation = cancellationToken();
    let requestSignal: AbortSignal | undefined;
    apiCall.mockImplementation((_operation, _input, options: { signal: AbortSignal }) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });

    const pending = providers.typeDefinition!.provideTypeDefinition(
      model(), { lineNumber: 1, column: 1 }, cancellation.token,
    );
    await Promise.resolve();
    await Promise.resolve();
    cancellation.cancel();

    await expect(pending).resolves.toEqual([]);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not cross the project boundary', async () => {
    const { providers } = harness();
    const token = cancellationToken().token;

    await expect(providers.typeDefinition!.provideTypeDefinition(
      model(9), { lineNumber: 1, column: 1 }, token,
    )).resolves.toEqual([]);
    expect(apiCall).not.toHaveBeenCalled();
  });
});
