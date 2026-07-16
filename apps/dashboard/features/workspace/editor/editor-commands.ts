/**
 * Editor commands on the GLOBAL command registry (Search Everywhere +
 * keymap dialog + dispatcher). They proxy to the active Monaco editor via
 * getActiveEditor(), so they work regardless of which pane has focus.
 *
 * Comment toggles live here (besides the Monaco rules) because the
 * dispatcher tokenizes by e.code — layout-immune (ABNT2's slash included)
 * on every surface where the dispatcher is mounted.
 */
import { registerCommandHandlers } from '../../../keymap/commands.js';
import { getActiveEditor } from './editor-models.js';
import { registerNavCommands } from './nav-commands.js';
import { registerAiCompleteCommands } from './ai-complete-commands.js';
import { organizeImportsInActiveEditor } from './lsp/organize-imports.js';
import { navigateDiagnostic } from './diagnostic-navigation.js';

function trigger(actionId: string): void {
  const editor = getActiveEditor();
  if (!editor) return;
  editor.focus();
  editor.trigger('keymap', actionId, null);
}

/** IntelliJ-style toggle case: selection (or word at cursor) upper↔lower. */
function toggleCase(): void {
  const editor = getActiveEditor();
  const model = editor?.getModel();
  if (!editor || !model) return;
  const edits = editor.getSelections()?.flatMap((sel) => {
    let range = sel;
    if (sel.isEmpty()) {
      const word = model.getWordAtPosition(sel.getPosition());
      if (!word) return [];
      range = sel.setStartPosition(sel.startLineNumber, word.startColumn)
        .setEndPosition(sel.endLineNumber, word.endColumn);
    }
    const text = model.getValueInRange(range);
    if (!text) return [];
    const next = text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase();
    return [{ range, text: next, forceMoveMarkers: false }];
  });
  if (edits?.length) editor.executeEdits('keymap.toggleCase', edits);
}

export function registerEditorCommands(): () => void {
  // Navegação de cursor (back/forward) + next/prev change — registrados junto
  // para que ProjectView continue com um único ponto de (des)registro.
  const unregisterNav = registerNavCommands();
  const unregisterAi = registerAiCompleteCommands();
  const monacoActions: Record<string, string> = {
    'editor.toggleLineComment': 'editor.action.commentLine',
    'editor.toggleBlockComment': 'editor.action.blockComment',
    'editor.quickFix': 'editor.action.quickFix',
    'editor.triggerSuggest': 'editor.action.triggerSuggest',
    'editor.parameterHints': 'editor.action.triggerParameterHints',
    'editor.showHover': 'editor.action.showHover',
    'editor.duplicateLine': 'editor.action.copyLinesDownAction',
    'editor.deleteLine': 'editor.action.deleteLines',
    'editor.moveLineUp': 'editor.action.moveLinesUpAction',
    'editor.moveLineDown': 'editor.action.moveLinesDownAction',
    'editor.joinLines': 'editor.action.joinLines',
    'editor.expandSelection': 'editor.action.smartSelect.expand',
    'editor.shrinkSelection': 'editor.action.smartSelect.shrink',
    'editor.addNextOccurrence': 'editor.action.addSelectionToNextFindMatch',
    'editor.selectAllOccurrences': 'editor.action.selectHighlights',
    'editor.cursorAbove': 'editor.action.insertCursorAbove',
    'editor.cursorBelow': 'editor.action.insertCursorBelow',
    'editor.definition': 'editor.action.revealDefinition',
    'editor.implementation': 'editor.action.goToImplementation',
    'editor.references': 'editor.action.goToReferences',
    'editor.rename': 'editor.action.rename',
    'editor.fold': 'editor.fold',
    'editor.unfold': 'editor.unfold',
    'editor.foldAll': 'editor.foldAll',
    'editor.unfoldAll': 'editor.unfoldAll',
    'editor.addSelectionToChat': 'mcp.addSelectionToChat',
    'editor.addFileToChat': 'mcp.addFileToChat',
    'editor.semanticSearch': 'mcp.semanticSearch',
    'run.file': 'mcp.runFile',
  };
  const unregister = registerCommandHandlers([
    ...Object.entries(monacoActions).map(([id, actionId]) => ({ id, run: () => trigger(actionId) })),
    {
      id: 'editor.toggleCase',
      run: toggleCase,
    },
    {
      id: 'editor.organizeImports',
      run: () => void organizeImportsInActiveEditor(),
    },
    {
      id: 'editor.nextProblem',
      run: () => {
        const editor = getActiveEditor();
        if (editor) navigateDiagnostic(editor, 'next');
      },
    },
    {
      id: 'editor.previousProblem',
      run: () => {
        const editor = getActiveEditor();
        if (editor) navigateDiagnostic(editor, 'previous');
      },
    },
    {
      id: 'editor.format',
      run: () => {
        const editor = getActiveEditor();
        if (!editor) return;
        const hasSelection = editor.getSelections()?.some((selection) => !selection.isEmpty()) ?? false;
        trigger(hasSelection ? 'editor.action.formatSelection' : 'editor.action.formatDocument');
      },
    },
  ]);
  return () => {
    unregister();
    unregisterNav();
    unregisterAi();
  };
}
