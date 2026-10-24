/**
 * Completion provider LSP do Monaco (extraído de lspProvider.ts — W4 decompose).
 * Per-família trigger characters + um fallback '*' (Ctrl+Space manual) para as demais
 * linguagens; o backend decide quem responde. Registrar '*' sobre uma linguagem
 * específica chamaria duas vezes, então o fallback pula os ids já cobertos.
 */
import type * as MonacoNs from 'monaco-editor';
import type { LspServerStatus } from '@mcp/api-bus';
import { apiCall } from '../../../../lib/api-client.js';
import { incrementLspCounter, logLsp } from '../lsp-log.js';
import { withMonacoCancellation } from './cancellation.js';
import { rerankCompletionEntries } from './local-rerank.js';
import {
  ANGULAR_COMPLETION_TRIGGERS,
  COMPLETION_TRIGGERS,
  mapCompletionKind,
  mergeCompletionTriggers,
  modelBelongsToProject,
  relPath,
  toEditOps,
  type CompletionItemDTO,
  type CompletionListDTO,
  type Monaco,
  type SuggestionWithMeta,
} from './dto.js';

export function registerCompletionProviders(
  monaco: Monaco,
  projectId: number,
  /** Drena o didChange pendente do arquivo antes de consultar o server (anti-race). */
  ensureSynced: (model: MonacoNs.editor.ITextModel) => Promise<void>,
): MonacoNs.IDisposable[] {
  const disposers: MonacoNs.IDisposable[] = [];
  const specificallyRegistered = new Set(Object.keys(COMPLETION_TRIGGERS));

  const registerSpecificProvider = (
    languageId: string,
    triggerCharacters: string[],
  ): MonacoNs.IDisposable => {
    const registration = monaco.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters,
      provideCompletionItems: completionProvider.provideCompletionItems.bind(completionProvider),
      resolveCompletionItem: completionProvider.resolveCompletionItem?.bind(completionProvider),
    });
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        registration.dispose();
      },
    };
  };

  // Monaco names this enum in the singular. Preserve the numeric fallback for
  // lightweight test adapters that omit the runtime enum object.
  const SNIPPET_RULE: MonacoNs.languages.CompletionItemInsertTextRule =
    monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet ?? 4;

  const wordRange = (model: MonacoNs.editor.ITextModel, position: MonacoNs.Position): MonacoNs.IRange => {
    const word = model.getWordUntilPosition(position);
    return {
      startLineNumber: position.lineNumber, startColumn: word.startColumn,
      endLineNumber: position.lineNumber, endColumn: word.endColumn,
    };
  };

  const validRange = (
    model: MonacoNs.editor.ITextModel,
    position: MonacoNs.Position,
    range: { start: { line: number; column: number }; end: { line: number; column: number } },
  ): boolean => {
    if (range.start.line !== position.lineNumber || range.end.line !== position.lineNumber) return false;
    if (range.start.column > range.end.column) return false;
    if (range.start.column > position.column || range.end.column < position.column) return false;
    const maxColumn = model.getLineMaxColumn(position.lineNumber);
    return range.start.column >= 1 && range.end.column <= maxColumn;
  };

  const completionRange = (
    item: CompletionItemDTO,
    model: MonacoNs.editor.ITextModel,
    position: MonacoNs.Position,
  ): MonacoNs.languages.CompletionItem['range'] => {
    const fallback = wordRange(model, position);
    if (item.insertReplaceEdit) {
      const { insert, replace } = item.insertReplaceEdit;
      if (!validRange(model, position, insert) || !validRange(model, position, replace)) {
        incrementLspCounter('rangeCorrected');
        return fallback;
      }
      return {
        insert: new monaco.Range(insert.start.line, insert.start.column, insert.end.line, insert.end.column),
        replace: new monaco.Range(replace.start.line, replace.start.column, replace.end.line, replace.end.column),
      };
    }
    if (item.textEdit) {
      const { range } = item.textEdit;
      if (!validRange(model, position, range)) {
        incrementLspCounter('rangeCorrected');
        return fallback;
      }
      return new monaco.Range(range.start.line, range.start.column, range.end.line, range.end.column);
    }
    return fallback;
  };

  const mapSuggestion = (
    e: CompletionItemDTO, model: MonacoNs.editor.ITextModel,
    position: MonacoNs.Position, file: string,
  ): SuggestionWithMeta => ({
    // Rich label (type/namespace columns) when the server sent labelDetails.
    label: e.labelDetails ? { label: e.label, detail: e.labelDetails.detail, description: e.labelDetails.description } : e.label,
    kind: mapCompletionKind(monaco, e.kind),
    insertText: e.insertText ?? e.label,
    detail: [e.detail, e.origin ? `Source: ${e.origin.toUpperCase()}` : ''].filter(Boolean).join(' · ') || undefined,
    documentation: e.documentation,
    // Snippet ONLY when the producer declared format 2 — else a literal
    // `${1:..}`/`$1` would be inserted verbatim.
    insertTextRules: e.insertTextFormat === 2 ? SNIPPET_RULE : undefined,
    // Preserve the producer's relevance order; without sortText Monaco
    // re-sorts alphabetically and the ranking collapses.
    sortText: e.sortText,
    filterText: e.filterText,
    preselect: e.preselect,
    commitCharacters: e.commitCharacters,
    // Server-chosen replace range is authoritative for `::`/`->` members;
    // fall back to the current word range.
    range: completionRange(e, model, position),
    additionalTextEdits: e.additionalTextEdits ? toEditOps(monaco, e.additionalTextEdits) : undefined,
    _raw: e.raw,
    _file: file,
    tags: e.deprecated || e.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
  });

  // Requests only supersede older requests for the SAME model. A split pane or
  // another tab must not cancel the active model's completion flight.
  const latestRequest = new WeakMap<MonacoNs.editor.ITextModel, number>();
  const completionProvider: MonacoNs.languages.CompletionItemProvider = {
    async provideCompletionItems(model, position, context, token) {
      if (!modelBelongsToProject(model, projectId)) return { suggestions: [] };
      const request = (latestRequest.get(model) ?? 0) + 1;
      latestRequest.set(model, request);
      const file = relPath(model);
      const lang = model.getLanguageId();
      const t0 = performance.now();
      try {
        // Serializa didChange→completion: drena o didChange desta tecla (e espera ele
        // chegar ao stdin FIFO do server) ANTES de pedir a completion — senão a completion
        // corre na frente do didChange e o server computa sobre um buffer velho → []. No-op
        // quando não há pending (Ctrl+Space / arquivo não-sincronizado).
        await ensureSynced(model);
        if (token.isCancellationRequested || request !== latestRequest.get(model)) return { suggestions: [] };
        const response = await withMonacoCancellation(token, (signal) =>
          apiCall<CompletionListDTO>('lsp.completion', {
            projectId,
            file,
            position: { line: position.lineNumber, column: position.column },
            // Monaco triggerKind (Invoke 0 / TriggerCharacter 1 / Incomplete 2)
            // → LSP (1 / 2 / 3): +1.
            context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
          }, { signal }));
        if (token.isCancellationRequested || request !== latestRequest.get(model) || model.isDisposed()) return { suggestions: [] };
        // Rerank local do top-K (n-gram vivo + prefixo digitado) — só reescreve
        // o sortText dos 5 primeiros; o resto preserva a ordem do producer.
        const entries = rerankCompletionEntries(response.items, model, position);
        // Fase 0 — observabilidade: distinguir "vazio" de "lançou" é o que separa
        // "backend alcançável mas mudo" de "provider lançou" no diagnóstico de P2.
        logLsp({ op: 'completion', file, lang, outcome: entries.length ? 'ok' : 'empty',
                 count: entries.length, ms: performance.now() - t0 });
        // `incomplete` controla o re-query do Monaco. Lista saudável (1-119) → o Monaco
        // FILTRA client-side sem re-consultar (corta o churn que antes era a CADA tecla
        // p/ PHP). Vazia → re-query (server esquentando / índice ainda sem match). Capada
        // (≥120) → re-query (pode haver mais). Com o flush acima, a re-query do caso vazio
        // já não vem de race (didChange atrasado), e sim de cold-boot real.
        return {
          suggestions: entries.map((e) => mapSuggestion(e, model, position, file)),
          incomplete: response.isIncomplete,
        };
      } catch (err) {
        logLsp({ op: 'completion', file, lang, outcome: 'threw',
                 ms: performance.now() - t0, err: err instanceof Error ? err.message : String(err) });
        return { suggestions: [] };
      }
    },

    // Called by Monaco when an item is focused in the widget — fetch the
    // deferred fields (Intelephense/Pyright attach the use/import edit
    // ONLY here) before the user can accept.
    async resolveCompletionItem(item, token) {
      const it = item as SuggestionWithMeta;
      if (!it._raw || (it.additionalTextEdits && it.additionalTextEdits.length > 0)) return item;
      try {
        const resolved = await withMonacoCancellation(token, (signal) =>
          apiCall<CompletionItemDTO | null>('lsp.resolveCompletion', {
            projectId, file: it._file, item: it._raw,
          }, { signal }));
        if (resolved?.additionalTextEdits?.length) {
          it.additionalTextEdits = toEditOps(monaco, resolved.additionalTextEdits);
        }
        if (resolved?.detail && !it.detail) it.detail = resolved.detail;
        if (resolved?.documentation) it.documentation = resolved.documentation;
        // Observabilidade do auto-import: `ok count≥1` = o server/serviço entregou os
        // edits de `use`/`import`; `empty` = não veio nada (config/round-trip a investigar).
        logLsp({ op: 'resolve', file: it._file ?? '', lang: '',
                 outcome: resolved?.additionalTextEdits?.length ? 'ok' : 'empty',
                 count: resolved?.additionalTextEdits?.length ?? 0 });
      } catch (err) {
        logLsp({ op: 'resolve', file: it._file ?? '', lang: '', outcome: 'threw',
                 err: err instanceof Error ? err.message : String(err) });
        /* keep the unresolved item — completion still inserts */
      }
      return item;
    },
  };

  let typescriptRegistration: MonacoNs.IDisposable | undefined;
  for (const [lang, triggerCharacters] of Object.entries(COMPLETION_TRIGGERS)) {
    const registration = registerSpecificProvider(lang, triggerCharacters);
    if (lang === 'typescript') typescriptRegistration = registration;
    disposers.push(registration);
  }

  // Angular-only trigger characters (`*`, `[`, `(`, `$`, `|`) must never hit
  // the completion hot path in an ordinary TS project. Resolve the effective
  // project overlay once, then atomically replace the TS registration and add
  // HTML only when this project is actually Angular. JavaScript stays base-only:
  // the Angular overlay does not own JS documents.
  let asyncDisposed = false;
  const angularRegistrations: MonacoNs.IDisposable[] = [];
  disposers.push({
    dispose() {
      if (asyncDisposed) return;
      asyncDisposed = true;
      for (const registration of angularRegistrations.splice(0)) registration.dispose();
    },
  });
  void apiCall<LspServerStatus>('lsp.serverStatus', { projectId, languageId: 'typescript' })
    .then((status) => {
      const familyId = status.server?.familyId ?? status.server?.id;
      if (asyncDisposed || familyId !== 'angular-language-server') return;
      const angularTypescriptTriggers = mergeCompletionTriggers(
        COMPLETION_TRIGGERS.typescript,
        ANGULAR_COMPLETION_TRIGGERS,
      );
      const nextTypescript = registerSpecificProvider('typescript', angularTypescriptTriggers);
      typescriptRegistration?.dispose();
      angularRegistrations.push(nextTypescript);

      const htmlRegistration = registerSpecificProvider('html', [...ANGULAR_COMPLETION_TRIGGERS]);
      specificallyRegistered.add('html');
      angularRegistrations.push(htmlRegistration);
    })
    .catch(() => undefined);

  disposers.push(
    monaco.languages.registerCompletionItemProvider('*', {
      async provideCompletionItems(model, position, context, token) {
        if (!modelBelongsToProject(model, projectId)) return { suggestions: [] };
        if (specificallyRegistered.has(model.getLanguageId())) return { suggestions: [] };
        return completionProvider.provideCompletionItems(
          model, position, context, token,
        ) as MonacoNs.languages.ProviderResult<MonacoNs.languages.CompletionList>;
      },
      resolveCompletionItem: completionProvider.resolveCompletionItem?.bind(completionProvider),
    }),
  );

  return disposers;
}
