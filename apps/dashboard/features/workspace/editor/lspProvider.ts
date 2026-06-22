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
 * registerLspProviders ao montar/trocar de projeto, unregisterLspProviders no
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
import {
  registerEditorOpener,
  registerNavProviders,
  registerSemanticTokenProviders,
} from './lsp/navigation.js';

type Monaco = typeof MonacoNs;

// One disposer set per projectId, REF-COUNTED. The editor can mount two Monaco
// instances for the same project at once (split view) — each MonacoMount's
// project-scoped effect calls register on mount and unregister on cleanup. A
// bare register/dispose pair would let the FIRST pane to unmount tear down the
// providers the surviving pane still needs; ref-counting holds them until the
// LAST pane of the project goes away. We still only ever have ONE project with
// live panes at a time, so registering a NEW project force-disposes the others.
const registrations = new Map<number, { disposers: MonacoNs.IDisposable[]; refs: number }>();

export function registerLspProviders(monaco: Monaco, projectId: number): void {
  // Same project, another pane — just bump the ref count (idempotent wiring).
  const existing = registrations.get(projectId);
  if (existing) {
    existing.refs += 1;
    return;
  }
  // New project — tear down every other project's providers (one project at a time).
  for (const [otherId, reg] of registrations) {
    reg.disposers.forEach((d) => d.dispose());
    registrations.delete(otherId);
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
  disposers.push(registerCodeActionProvider(monaco, projectId, docSync.flush));
  disposers.push(...registerNavProviders(monaco, projectId));
  disposers.push(registerEditorOpener(monaco, projectId));
  // AI ghost text — heavily gated (default OFF; see inlineCompletionProvider).
  disposers.push(registerInlineCompletions(monaco, projectId));

  registrations.set(projectId, { disposers, refs: 1 });
}

export function unregisterLspProviders(projectId: number): void {
  const reg = registrations.get(projectId);
  if (!reg) return;
  reg.refs -= 1;
  if (reg.refs > 0) return; // another pane of this project still needs them
  reg.disposers.forEach((d) => d.dispose());
  registrations.delete(projectId);
}

/** Test-only: dispose & clear the whole registry (ref counts can be >1 with splits). */
export function __resetLspRegistryForTests(): void {
  for (const [id, reg] of registrations) {
    reg.disposers.forEach((d) => d.dispose());
    registrations.delete(id);
  }
}
