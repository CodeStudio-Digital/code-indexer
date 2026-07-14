import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiCall } = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock('../../../../lib/api-client.js', () => ({ apiCall }));
vi.mock('../lsp-log.js', () => ({ logLsp: vi.fn() }));

import { registerCompletionProviders } from '../lsp/completion.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('completion provider fidelity', () => {
  beforeEach(() => apiCall.mockReset());

  it('preserves server isIncomplete and discards obsolete responses', async () => {
    const providers: Array<{ provideCompletionItems: Function }> = [];
    class Range { constructor(public a: number, public b: number, public c: number, public d: number) {} }
    const monaco = {
      Range,
      languages: {
        CompletionItemInsertTextRules: { InsertAsSnippet: 4 },
        CompletionItemTag: { Deprecated: 1 },
        CompletionItemKind: new Proxy({}, { get: () => 1 }),
        registerCompletionItemProvider: (_lang: string, provider: { provideCompletionItems: Function }) => {
          providers.push(provider); return { dispose() {} };
        },
      },
    } as never;
    registerCompletionProviders(monaco, 1, async () => undefined);
    const provider = providers[0]!;
    const model = {
      getLanguageId: () => 'typescript', isDisposed: () => false,
      uri: { path: '/project/1/src/a.ts' },
      getWordUntilPosition: () => ({ startColumn: 1, endColumn: 2 }),
    };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const first = deferred<{ items: Array<{ label: string; kind: string }>; isIncomplete: boolean }>();
    const second = deferred<{ items: Array<{ label: string; kind: string }>; isIncomplete: boolean }>();
    apiCall.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const oldRequest = provider.provideCompletionItems(model, { lineNumber: 1, column: 2 }, { triggerKind: 0 }, token);
    await Promise.resolve();
    const currentRequest = provider.provideCompletionItems(model, { lineNumber: 1, column: 2 }, { triggerKind: 0 }, token);
    await Promise.resolve();
    first.resolve({ items: [{ label: 'old', kind: 'text' }], isIncomplete: false });
    second.resolve({ items: [{ label: 'current', kind: 'text' }], isIncomplete: true });

    expect(await oldRequest).toEqual({ suggestions: [] });
    const current = await currentRequest;
    expect(current.incomplete).toBe(true);
    expect(current.suggestions[0].label).toBe('current');
  });
});
