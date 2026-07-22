/**
 * Wire the @mcp/api-bus lsp.* methods into Monaco's provider registry.
 *
 * Onda 2 architecture (IDE-grade): documentSync streams didOpen/didChange/didClose
 * (position-based calls carry only {file, position}); diagnostics são PUSHED
 * (diagnosticsStream); os providers registram para '*' e o BACKEND roteia por
 * linguagem (ts/js → TS service in-process; com LSP server instalado → o server;
 * resto → fallback do índice estrutural).
 *
 * Lifecycle: a registração é DIRIGIDA pelo efeito project-scoped do MonacoMount —
 * registerLspProviders ao montar/trocar de projeto e descarta o lease retornado no
 * cleanup (desmontar/trocar). Sem esse par, os providers (documentSync, stream de
 * diagnósticos, completion/nav) vazavam a cada troca de projeto. registerLspProviders
 * é idempotente por projectId (re-mounts/troca de aba no mesmo projeto são baratos) e
 * o loop "derruba os outros" abaixo é só uma defesa extra p/ manter 1 projeto ativo.
 * Os providers em si vivem em ./lsp/{completion,navigation}.ts e os helpers puros em
 * ./lsp/dto.ts (W4 decompose); este arquivo é só o registry.
 */
import type * as MonacoNs from 'monaco-editor';
import { startDocumentSync } from './documentSync.js';
import { startDiagnosticsStream } from './diagnosticsStream.js';
import { registerInlineCompletions } from './inlineCompletionProvider.js';
import { registerCodeActionProvider } from './lsp/codeActions.js';
import { registerCompletionProviders } from './lsp/completion.js';
import { registerRenameProviders } from './lsp/rename.js';
import { registerSignatureHelpProviders } from './lsp/signatureHelp.js';
import { registerDocumentSymbolProviders } from './lsp/documentSymbols.js';
import { registerFormattingProviders } from './lsp/formatting.js';
import { registerAdvancedLanguageFeatureProviders } from './lsp/advancedLanguageFeatures.js';
import { registerSymbolNavigationCodeLensProvider } from './lsp/symbol-navigation-ui.js';
import {
  registerEditorOpener,
  registerNavProviders,
  registerSemanticTokenProviders,
} from './lsp/navigation.js';
import { startLspServerReadyStream } from './lsp/server-ready.js';

type Monaco = typeof MonacoNs;

// One disposer set per projectId, REF-COUNTED. The editor can mount two Monaco
// instances for the same project at once (split view) — each MonacoMount's
// project-scoped effect calls register on mount and unregister on cleanup. A
// bare register/dispose pair would let the FIRST pane to unmount tear down the
// providers the surviving pane still needs; ref-counting holds them until the
// LAST pane of the project goes away. We still only ever have ONE project with
// live panes at a time, so registering a NEW project force-disposes the others.
interface ProviderRegistration {
  generation: number;
  disposers: MonacoNs.IDisposable[];
  refs: number;
  disposed: boolean;
}

const registrations = new Map<number, ProviderRegistration>();
let nextGeneration = 1;

function disposeRegistration(projectId: number, registration: ProviderRegistration): void {
  if (registration.disposed) return;
  registration.disposed = true;
  registration.disposers.forEach((d) => d.dispose());
  if (registrations.get(projectId) === registration) registrations.delete(projectId);
}

export function registerLspProviders(monaco: Monaco, projectId: number): MonacoNs.IDisposable {
  // Same project, another pane — just bump the ref count (idempotent wiring).
  const existing = registrations.get(projectId);
  if (existing) {
    existing.refs += 1;
    const generation = existing.generation;
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        // Identity (and therefore generation) is load-bearing: a delayed cleanup
        // from A1 must never decrement/dispose a later A2 registration.
        if (registrations.get(projectId) !== existing || existing.generation !== generation || existing.disposed) return;
        existing.refs -= 1;
        if (existing.refs === 0) disposeRegistration(projectId, existing);
      },
    };
  }
  // New project — tear down every other project's providers (one project at a time).
  for (const [otherId, reg] of registrations) {
    disposeRegistration(otherId, reg);
  }

  const disposers: MonacoNs.IDisposable[] = [];
  // Document sync FIRST — didOpen lands before the first provider request in the
  // common path, so the backend reads the live buffer (a lost race degrades to
  // disk content, never an error). Guardamos o handle p/ a completion DRENAR o
  // didChange pendente antes de consultar o server (conserta a race que devolvia []).
  const docSync = startDocumentSync(monaco, projectId);
  disposers.push(docSync);
  disposers.push(startDiagnosticsStream(monaco, projectId));
  disposers.push(...registerSemanticTokenProviders(monaco, projectId, docSync.ensureSynced));
  disposers.push(...registerCompletionProviders(monaco, projectId, docSync.ensureSynced));
  disposers.push(registerCodeActionProvider(monaco, projectId, docSync.ensureSynced));
  disposers.push(...registerRenameProviders(monaco, projectId, docSync.ensureSynced));
  disposers.push(...registerSignatureHelpProviders(monaco, projectId, docSync.ensureSynced));
  disposers.push(...registerDocumentSymbolProviders(monaco, projectId, docSync.ensureSynced));
  disposers.push(...registerAdvancedLanguageFeatureProviders(monaco, projectId, docSync.ensureSynced));
  disposers.push(...registerSymbolNavigationCodeLensProvider(monaco, projectId, docSync.ensureSynced));
  // Server-backed formatting (php) — NOT '*', keeps Monaco's built-ins visible.
  disposers.push(...registerFormattingProviders(monaco, projectId, docSync.ensureSynced));
  disposers.push(...registerNavProviders(monaco, projectId, docSync.ensureSynced));
  disposers.push(registerEditorOpener(monaco, projectId));
  // AI ghost text — heavily gated (default OFF; see inlineCompletionProvider).
  disposers.push(registerInlineCompletions(monaco, projectId));
  // Start after consumers subscribed so the backend's replayed ready snapshot
  // cannot race past semantic-token / CodeLens listeners.
  disposers.push(startLspServerReadyStream(projectId));

  const registration: ProviderRegistration = {
    generation: nextGeneration++,
    disposers,
    refs: 1,
    disposed: false,
  };
  registrations.set(projectId, registration);
  const generation = registration.generation;

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (registrations.get(projectId) !== registration || registration.generation !== generation || registration.disposed) return;
      registration.refs -= 1;
      if (registration.refs === 0) disposeRegistration(projectId, registration);
    },
  };
}

/** Test-only: dispose & clear the whole registry (ref counts can be >1 with splits). */
export function __resetLspRegistryForTests(): void {
  for (const [id, reg] of registrations) {
    disposeRegistration(id, reg);
  }
}
