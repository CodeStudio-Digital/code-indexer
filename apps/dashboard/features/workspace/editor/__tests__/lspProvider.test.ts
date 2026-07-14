/**
 * Registry bookkeeping for the LSP provider lifecycle.
 *
 * The leak fix wires `unregisterLspProviders` into MonacoMount's project-scoped
 * effect (register on mount/project change, unregister on cleanup). These tests
 * pin the registry contract that fix relies on: register is idempotent per
 * projectId, switching projects tears the previous project's disposers down, and
 * unregister empties the registry so re-opening the same project registers fresh.
 *
 * The provider sub-modules are mocked to spy disposers so this isolates the
 * registry — the actual unit under change — without a live Monaco instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const disposer = () => ({ dispose: vi.fn() });

vi.mock('../documentSync.js', () => ({
  startDocumentSync: vi.fn(() => ({ dispose: vi.fn(), flush: vi.fn() })),
}));
vi.mock('../diagnosticsStream.js', () => ({
  startDiagnosticsStream: vi.fn(() => disposer()),
}));
vi.mock('../inlineCompletionProvider.js', () => ({
  registerInlineCompletions: vi.fn(() => disposer()),
}));
vi.mock('../lsp/codeActions.js', () => ({
  registerCodeActionProvider: vi.fn(() => disposer()),
}));
vi.mock('../lsp/completion.js', () => ({
  registerCompletionProviders: vi.fn(() => [disposer()]),
}));
vi.mock('../lsp/rename.js', () => ({
  registerRenameProviders: vi.fn(() => [disposer()]),
}));
vi.mock('../lsp/signatureHelp.js', () => ({
  registerSignatureHelpProviders: vi.fn(() => [disposer()]),
}));
vi.mock('../lsp/documentSymbols.js', () => ({
  registerDocumentSymbolProviders: vi.fn(() => [disposer()]),
}));
vi.mock('../lsp/symbol-navigation-ui.js', () => ({
  registerSymbolNavigationCodeLensProvider: vi.fn(() => [disposer()]),
}));
vi.mock('../lsp/formatting.js', () => ({
  registerFormattingProviders: vi.fn(() => [disposer()]),
}));
vi.mock('../lsp/navigation.js', () => ({
  registerSemanticTokenProviders: vi.fn(() => [disposer()]),
  registerNavProviders: vi.fn(() => [disposer()]),
  registerEditorOpener: vi.fn(() => disposer()),
}));

import { registerLspProviders, unregisterLspProviders, __resetLspRegistryForTests } from '../lspProvider.js';
import { startDocumentSync } from '../documentSync.js';
import { startDiagnosticsStream } from '../diagnosticsStream.js';
import { registerInlineCompletions } from '../inlineCompletionProvider.js';
import { registerCodeActionProvider } from '../lsp/codeActions.js';
import { registerCompletionProviders } from '../lsp/completion.js';
import { registerRenameProviders } from '../lsp/rename.js';
import { registerSignatureHelpProviders } from '../lsp/signatureHelp.js';
import { registerDocumentSymbolProviders } from '../lsp/documentSymbols.js';
import { registerSymbolNavigationCodeLensProvider } from '../lsp/symbol-navigation-ui.js';
import { registerFormattingProviders } from '../lsp/formatting.js';
import {
  registerSemanticTokenProviders,
  registerNavProviders,
  registerEditorOpener,
} from '../lsp/navigation.js';

// A fake Monaco namespace — the mocked sub-providers ignore it.
const monaco = {} as never;

const SUB_PROVIDERS = [
  startDocumentSync,
  startDiagnosticsStream,
  registerInlineCompletions,
  registerCodeActionProvider,
  registerCompletionProviders,
  registerRenameProviders,
  registerSignatureHelpProviders,
  registerDocumentSymbolProviders,
  registerSymbolNavigationCodeLensProvider,
  registerFormattingProviders,
  registerSemanticTokenProviders,
  registerNavProviders,
  registerEditorOpener,
];

interface Disposer { dispose: ReturnType<typeof vi.fn> }

/** Every disposer returned across all sub-provider mocks so far (arrays flattened). */
function allDisposers(): Disposer[] {
  const out: Disposer[] = [];
  for (const fn of SUB_PROVIDERS) {
    for (const r of vi.mocked(fn).mock.results) {
      if (r.type !== 'return') continue;
      const v = r.value as unknown;
      if (Array.isArray(v)) out.push(...(v as Disposer[]));
      else out.push(v as Disposer);
    }
  }
  return out;
}

describe('lspProvider registry', () => {
  beforeEach(() => {
    // The registry is module-level state and now ref-counted (a project can be
    // registered more than once via splits), so drain it fully before each test.
    __resetLspRegistryForTests();
    vi.clearAllMocks();
  });

  it('wires every sub-provider once for the project', () => {
    registerLspProviders(monaco, 1);
    expect(startDocumentSync).toHaveBeenCalledTimes(1);
    expect(startDocumentSync).toHaveBeenCalledWith(monaco, 1);
    expect(startDiagnosticsStream).toHaveBeenCalledWith(monaco, 1);
    expect(registerSemanticTokenProviders).toHaveBeenCalledWith(monaco, 1);
    expect(registerNavProviders).toHaveBeenCalledWith(monaco, 1);
    expect(registerEditorOpener).toHaveBeenCalledWith(monaco, 1);
    expect(registerInlineCompletions).toHaveBeenCalledWith(monaco, 1);
    // completion + code actions also receive docSync.flush.
    expect(registerCompletionProviders).toHaveBeenCalledWith(monaco, 1, expect.any(Function));
    expect(registerCodeActionProvider).toHaveBeenCalledWith(monaco, 1, expect.any(Function));
  });

  it('is idempotent for the same project — no re-registration', () => {
    registerLspProviders(monaco, 1);
    vi.clearAllMocks();
    registerLspProviders(monaco, 1);
    expect(startDocumentSync).not.toHaveBeenCalled();
  });

  it('switching projects disposes the previous project disposers', () => {
    registerLspProviders(monaco, 1);
    const projectOne = allDisposers();
    expect(projectOne.length).toBeGreaterThan(0);

    registerLspProviders(monaco, 2);
    for (const d of projectOne) expect(d.dispose).toHaveBeenCalledTimes(1);
    expect(startDocumentSync).toHaveBeenCalledWith(monaco, 2);
  });

  it('unregister disposes the project and empties the registry', () => {
    registerLspProviders(monaco, 2);
    const projectTwo = allDisposers();
    expect(projectTwo.length).toBeGreaterThan(0);

    unregisterLspProviders(2);
    for (const d of projectTwo) expect(d.dispose).toHaveBeenCalledTimes(1);

    // Registry now empty → re-opening registers fresh (not idempotent-skipped).
    vi.clearAllMocks();
    registerLspProviders(monaco, 2);
    expect(startDocumentSync).toHaveBeenCalledTimes(1);
  });

  it('unregister is a no-op for a project that was never registered', () => {
    expect(() => unregisterLspProviders(999)).not.toThrow();
  });

  it('ref-counts the same project (split view) — providers survive until the last pane unregisters', () => {
    registerLspProviders(monaco, 1); // pane A
    const projectOne = allDisposers();
    expect(projectOne.length).toBeGreaterThan(0);

    registerLspProviders(monaco, 1); // pane B — same project, no re-wiring
    // First pane unmounts: providers MUST stay alive for the surviving pane.
    unregisterLspProviders(1);
    for (const d of projectOne) expect(d.dispose).not.toHaveBeenCalled();

    // Last pane unmounts: now they tear down.
    unregisterLspProviders(1);
    for (const d of projectOne) expect(d.dispose).toHaveBeenCalledTimes(1);
  });
});
