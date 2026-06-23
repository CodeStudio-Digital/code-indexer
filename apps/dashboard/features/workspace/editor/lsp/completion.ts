/**
 * Completion provider LSP do Monaco (extraído de lspProvider.ts — W4 decompose).
 * Per-família trigger characters + um fallback '*' (Ctrl+Space manual) para as demais
 * linguagens; o backend decide quem responde. Registrar '*' sobre uma linguagem
 * específica chamaria duas vezes, então o fallback pula os ids já cobertos.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../../lib/api-client.js';
import { logLsp } from '../lsp-log.js';
import {
  COMPLETION_TRIGGERS,
  mapCompletionKind,
  relPath,
  toEditOps,
  type CompletionItemDTO,
  type Monaco,
  type SuggestionWithMeta,
} from './dto.js';

export function registerCompletionProviders(
  monaco: Monaco,
  projectId: number,
  /** Drena o didChange pendente do arquivo antes de consultar o server (anti-race). */
  flushDoc: (rel: string) => Promise<void>,
): MonacoNs.IDisposable[] {
  const disposers: MonacoNs.IDisposable[] = [];

  // CAUSA-RAIZ DO P2 (autocomplete não abria): `monaco.languages.CompletionItemInsertTextRules`
  // é `undefined` no runtime deste bundle (const enum não exportado como objeto). Acessar
  // `.InsertAsSnippet` LANÇAVA dentro do map → o provider devolvia [] → popup vazio para
  // QUALQUER completion com item de snippet (método/função). Fallback ao literal (4).
  const SNIPPET_RULE = (monaco.languages.CompletionItemInsertTextRules?.InsertAsSnippet ?? 4) as MonacoNs.languages.CompletionItemInsertTextRules;

  const wordRange = (model: MonacoNs.editor.ITextModel, position: MonacoNs.Position): MonacoNs.IRange => {
    const word = model.getWordUntilPosition(position);
    return {
      startLineNumber: position.lineNumber, startColumn: word.startColumn,
      endLineNumber: position.lineNumber, endColumn: word.endColumn,
    };
  };

  const mapSuggestion = (
    e: CompletionItemDTO, model: MonacoNs.editor.ITextModel,
    position: MonacoNs.Position, file: string,
  ): SuggestionWithMeta => ({
    // Rich label (type/namespace columns) when the server sent labelDetails.
    label: e.labelDetails ? { label: e.label, detail: e.labelDetails.detail, description: e.labelDetails.description } : e.label,
    kind: mapCompletionKind(monaco, e.kind),
    insertText: e.insertText ?? e.label,
    detail: e.detail,
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
    range: e.textEdit
      ? new monaco.Range(
        e.textEdit.range.start.line, e.textEdit.range.start.column,
        e.textEdit.range.end.line, e.textEdit.range.end.column,
      )
      : wordRange(model, position),
    additionalTextEdits: e.additionalTextEdits ? toEditOps(monaco, e.additionalTextEdits) : undefined,
    _raw: e.raw,
    _file: file,
  });

  const completionProvider: MonacoNs.languages.CompletionItemProvider = {
    async provideCompletionItems(model, position, context) {
      const file = relPath(model);
      const lang = model.getLanguageId();
      const t0 = performance.now();
      try {
        // Serializa didChange→completion: drena o didChange desta tecla (e espera ele
        // chegar ao stdin FIFO do server) ANTES de pedir a completion — senão a completion
        // corre na frente do didChange e o server computa sobre um buffer velho → []. No-op
        // quando não há pending (Ctrl+Space / arquivo não-sincronizado).
        await flushDoc(file);
        const entries = await apiCall<CompletionItemDTO[]>('lsp.completion', {
          projectId,
          file,
          position: { line: position.lineNumber, column: position.column },
          // Monaco triggerKind (Invoke 0 / TriggerCharacter 1 / Incomplete 2)
          // → LSP (1 / 2 / 3): +1.
          context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
        });
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
          incomplete: entries.length === 0 || entries.length >= 120,
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
    async resolveCompletionItem(item) {
      const it = item as SuggestionWithMeta;
      if (!it._raw || (it.additionalTextEdits && it.additionalTextEdits.length > 0)) return item;
      try {
        const resolved = await apiCall<CompletionItemDTO | null>('lsp.resolveCompletion', {
          projectId, file: it._file, item: it._raw,
        });
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

  for (const [lang, triggerCharacters] of Object.entries(COMPLETION_TRIGGERS)) {
    disposers.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters,
        provideCompletionItems: completionProvider.provideCompletionItems.bind(completionProvider),
        resolveCompletionItem: completionProvider.resolveCompletionItem?.bind(completionProvider),
      }),
    );
  }
  disposers.push(
    monaco.languages.registerCompletionItemProvider('*', {
      async provideCompletionItems(model, position, context, token) {
        if (model.getLanguageId() in COMPLETION_TRIGGERS) return { suggestions: [] };
        return completionProvider.provideCompletionItems(
          model, position, context, token,
        ) as MonacoNs.languages.ProviderResult<MonacoNs.languages.CompletionList>;
      },
      resolveCompletionItem: completionProvider.resolveCompletionItem?.bind(completionProvider),
    }),
  );

  return disposers;
}
