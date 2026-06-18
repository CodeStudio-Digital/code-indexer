/**
 * Wire the @mcp/api-bus lsp.* methods into Monaco's provider registry.
 *
 * Onda 2 architecture (IDE-grade): documentSync streams didOpen/didChange/didClose
 * (position-based calls carry only {file, position}); diagnostics são PUSHED
 * (diagnosticsStream); os providers registram para '*' e o BACKEND roteia por
 * linguagem (ts/js → TS service in-process; com LSP server instalado → o server;
 * resto → fallback do índice estrutural).
 *
 * Registration é idempotente por projectId. Trocar de projeto derruba os providers
 * antigos e re-registra. Os providers em si vivem em ./lsp/{completion,navigation}.ts
 * e os helpers puros em ./lsp/dto.ts (W4 decompose); este arquivo é só o registry.
 */
import type * as MonacoNs from 'monaco-editor';
import { startDocumentSync } from './documentSync.js';
import { startDiagnosticsStream } from './diagnosticsStream.js';
import { registerInlineCompletions } from './inlineCompletionProvider.js';
import { registerCompletionProviders } from './lsp/completion.js';
import {
  registerEditorOpener,
  registerNavProviders,
  registerSemanticTokenProviders,
} from './lsp/navigation.js';

type Monaco = typeof MonacoNs;

// One disposer set per projectId. New project = wipe and re-register.
const registrations = new Map<number, { disposers: MonacoNs.IDisposable[] }>();

export function registerLspProviders(monaco: Monaco, projectId: number): void {
  // Tear down previous registration if the projectId changed.
  if (registrations.has(projectId)) return;
  for (const [otherId, reg] of registrations) {
    if (otherId !== projectId) {
      reg.disposers.forEach((d) => d.dispose());
      registrations.delete(otherId);
    }
  }

  const disposers: MonacoNs.IDisposable[] = [];
  // Document sync FIRST — didOpen lands before the first provider request in the
  // common path, so the backend reads the live buffer (a lost race degrades to
  // disk content, never an error). Guardamos o handle p/ a completion DRENAR o
  // didChange pendente antes de consultar o server (conserta a race que devolvia []).
  const docSync = startDocumentSync(monaco, projectId);
  disposers.push(docSync);
  disposers.push(startDiagnosticsStream(monaco, projectId));
  disposers.push(...registerSemanticTokenProviders(monaco, projectId));
  disposers.push(...registerCompletionProviders(monaco, projectId, docSync.flush));
  disposers.push(...registerNavProviders(monaco, projectId));
  disposers.push(registerEditorOpener(monaco, projectId));
  // AI ghost text — heavily gated (default OFF; see inlineCompletionProvider).
  disposers.push(registerInlineCompletions(monaco, projectId));

  registrations.set(projectId, { disposers });
}

export function unregisterLspProviders(projectId: number): void {
  const reg = registrations.get(projectId);
  if (!reg) return;
  reg.disposers.forEach((d) => d.dispose());
  registrations.delete(projectId);
}
