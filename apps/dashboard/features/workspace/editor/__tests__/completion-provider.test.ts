import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiCall } = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock('../../../../lib/api-client.js', () => ({ apiCall }));
vi.mock('../lsp-log.js', () => ({ logLsp: vi.fn(), incrementLspCounter: vi.fn() }));

import { registerCompletionProviders } from '../lsp/completion.js';
import {
  type CompletionListDTO,
  ANGULAR_COMPLETION_TRIGGERS,
  COMPLETION_TRIGGERS,
  mergeCompletionTriggers,
} from '../lsp/dto.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Registration {
  language: string;
  triggerCharacters?: string[];
  dispose: ReturnType<typeof vi.fn>;
}

function completionMonaco(registrations: Registration[]) {
  return {
    Range: class {},
    languages: {
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      CompletionItemTag: { Deprecated: 1 },
      CompletionItemKind: new Proxy({}, { get: () => 1 }),
      registerCompletionItemProvider: (language: string, provider: { triggerCharacters?: string[] }) => {
        const dispose = vi.fn();
        registrations.push({ language, triggerCharacters: provider.triggerCharacters, dispose });
        return { dispose };
      },
    },
  } as never;
}

async function settleServerStatus() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('completion provider fidelity', () => {
  beforeEach(() => {
    apiCall.mockReset();
  });

  it('keeps base TS/JS triggers and no HTML provider outside Angular projects', async () => {
    apiCall.mockResolvedValueOnce({ state: 'no-server' });
    const registrations: Registration[] = [];

    registerCompletionProviders(completionMonaco(registrations), 1, async () => undefined);
    await settleServerStatus();

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall).toHaveBeenCalledWith('lsp.serverStatus', {
      projectId: 1,
      languageId: 'typescript',
    });
    expect(registrations.filter((entry) => entry.language === 'typescript')).toHaveLength(1);
    expect(registrations.find((entry) => entry.language === 'typescript')?.triggerCharacters)
      .toEqual(COMPLETION_TRIGGERS.typescript);
    expect(registrations.filter((entry) => entry.language === 'javascript')).toHaveLength(1);
    expect(registrations.find((entry) => entry.language === 'javascript')?.triggerCharacters)
      .toEqual(COMPLETION_TRIGGERS.javascript);
    expect(registrations.some((entry) => entry.language === 'html')).toBe(false);
    for (const language of ['typescript', 'javascript']) {
      const triggers = registrations.find((entry) => entry.language === language)?.triggerCharacters ?? [];
      for (const angularOnlyTrigger of ['*', '[', '(', '$', '|']) {
        expect(triggers).not.toContain(angularOnlyTrigger);
      }
    }
  });

  it('promotes only TS and HTML to Angular triggers without duplicates', async () => {
    apiCall.mockResolvedValueOnce({
      state: 'not-installed',
      server: {
        id: 'angular-language-server--angular-12',
        familyId: 'angular-language-server',
        profileId: 'angular-12',
        label: 'Angular Language Server',
      },
    });
    const registrations: Registration[] = [];
    const disposers = registerCompletionProviders(
      completionMonaco(registrations),
      7,
      async () => undefined,
    );
    await settleServerStatus();

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall).toHaveBeenCalledWith('lsp.serverStatus', {
      projectId: 7,
      languageId: 'typescript',
    });

    const typescript = registrations.filter((entry) => entry.language === 'typescript');
    expect(typescript).toHaveLength(2);
    expect(typescript[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(typescript[1]?.triggerCharacters).toEqual(mergeCompletionTriggers(
      COMPLETION_TRIGGERS.typescript,
      ANGULAR_COMPLETION_TRIGGERS,
    ));
    expect(new Set(typescript[1]?.triggerCharacters).size)
      .toBe(typescript[1]?.triggerCharacters?.length);

    const javascript = registrations.filter((entry) => entry.language === 'javascript');
    expect(javascript).toHaveLength(1);
    expect(javascript[0]?.triggerCharacters).toEqual(COMPLETION_TRIGGERS.javascript);
    for (const angularOnlyTrigger of ['*', '[', '(', '$', '|']) {
      expect(javascript[0]?.triggerCharacters).not.toContain(angularOnlyTrigger);
    }

    const html = registrations.filter((entry) => entry.language === 'html');
    expect(html).toHaveLength(1);
    expect(html[0]?.triggerCharacters).toEqual([...ANGULAR_COMPLETION_TRIGGERS]);

    for (const disposer of disposers) disposer.dispose();
    expect(typescript[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(html[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores a late Angular status after provider teardown', async () => {
    const status = deferred<{
      state: string;
      server: { id: string; label: string };
    }>();
    apiCall.mockReturnValueOnce(status.promise);
    const registrations: Registration[] = [];
    const disposers = registerCompletionProviders(
      completionMonaco(registrations),
      1,
      async () => undefined,
    );
    const registrationCountAtTeardown = registrations.length;

    for (const disposer of disposers) disposer.dispose();
    status.resolve({
      state: 'ready',
      server: { id: 'angular-language-server', label: 'Angular Language Server' },
    });
    await settleServerStatus();

    expect(registrations).toHaveLength(registrationCountAtTeardown);
    expect(registrations.some((entry) => entry.language === 'html')).toBe(false);
    expect(registrations.every((entry) => entry.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('preserves server isIncomplete and discards obsolete responses', async () => {
    const providers: Array<{ provideCompletionItems: Function }> = [];
    class Range { constructor(public a: number, public b: number, public c: number, public d: number) {} }
    const monaco = {
      Range,
      languages: {
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        CompletionItemTag: { Deprecated: 1 },
        CompletionItemKind: new Proxy({}, { get: () => 1 }),
        registerCompletionItemProvider: (_lang: string, provider: { provideCompletionItems: Function }) => {
          providers.push(provider); return { dispose() {} };
        },
      },
    } as never;
    apiCall.mockResolvedValueOnce({ state: 'no-server' });
    registerCompletionProviders(monaco, 1, async () => undefined);
    const provider = providers[0]!;
    const model = {
      getLanguageId: () => 'typescript', isDisposed: () => false,
      uri: { path: '/p1/src/a.ts' },
      getWordUntilPosition: () => ({ startColumn: 1, endColumn: 2 }),
      getLineMaxColumn: () => 20,
    };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const first = deferred<CompletionListDTO>();
    const second = deferred<CompletionListDTO>();
    apiCall.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const oldRequest = provider.provideCompletionItems(model, { lineNumber: 1, column: 2 }, { triggerKind: 0 }, token);
    await Promise.resolve();
    const currentRequest = provider.provideCompletionItems(model, { lineNumber: 1, column: 2 }, { triggerKind: 0 }, token);
    await Promise.resolve();
    first.resolve({ items: [{ label: 'old', kind: 'text' }], isIncomplete: false });
    second.resolve({ items: [{
      label: 'current', kind: 'text',
      textEdit: {
        range: { start: { line: 14, column: 1 }, end: { line: 14, column: 5 } },
        newText: 'current',
      },
    }], isIncomplete: true });

    expect(await oldRequest).toEqual({ suggestions: [] });
    const current = await currentRequest;
    expect(current.incomplete).toBe(true);
    expect(current.suggestions[0].label).toBe('current');
    expect(current.suggestions[0].range).toEqual({
      startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2,
    });
  });

  it('does not let a request in one split/model cancel another model', async () => {
    const providers: Array<{ provideCompletionItems: Function }> = [];
    class Range { constructor(public a: number, public b: number, public c: number, public d: number) {} }
    const monaco = {
      Range,
      languages: {
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 }, CompletionItemTag: { Deprecated: 1 },
        CompletionItemKind: new Proxy({}, { get: () => 1 }),
        registerCompletionItemProvider: (_lang: string, provider: { provideCompletionItems: Function }) => {
          providers.push(provider); return { dispose() {} };
        },
      },
    } as never;
    apiCall.mockResolvedValueOnce({ state: 'no-server' });
    registerCompletionProviders(monaco, 1, async () => undefined);
    const model = (name: string) => ({
      getLanguageId: () => 'typescript', isDisposed: () => false,
      uri: { path: `/p1/src/${name}.ts` },
      getWordUntilPosition: () => ({ startColumn: 1, endColumn: 2 }), getLineMaxColumn: () => 20,
    });
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const first = deferred<CompletionListDTO>();
    const second = deferred<CompletionListDTO>();
    apiCall.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = providers[0]!.provideCompletionItems(model('a'), { lineNumber: 1, column: 2 }, { triggerKind: 0 }, token);
    await Promise.resolve();
    const b = providers[0]!.provideCompletionItems(model('b'), { lineNumber: 1, column: 2 }, { triggerKind: 0 }, token);
    await Promise.resolve();
    first.resolve({ items: [{ label: 'from-a', kind: 'text' }], isIncomplete: false });
    second.resolve({ items: [{ label: 'from-b', kind: 'text' }], isIncomplete: false });

    expect((await a).suggestions[0].label).toBe('from-a');
    expect((await b).suggestions[0].label).toBe('from-b');
  });
});
