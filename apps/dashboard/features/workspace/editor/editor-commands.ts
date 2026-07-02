/**
 * Editor commands on the GLOBAL command registry (Search Everywhere +
 * keymap dialog + dispatcher). They proxy to the active Monaco editor via
 * getActiveEditor(), so they work regardless of which pane has focus.
 *
 * Comment toggles live here (besides the Monaco rules) because the
 * dispatcher tokenizes by e.code — layout-immune (ABNT2's slash included)
 * on every surface where the dispatcher is mounted.
 */
import { registerCommands } from '../../../keymap/commands.js';
import { getActiveEditor } from './editor-models.js';
import { registerNavCommands } from './nav-commands.js';
import { registerAiCompleteCommands } from './ai-complete-commands.js';
import { organizeImportsInActiveEditor } from './lsp/organize-imports.js';

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
  const unregister = registerCommands([
    {
      id: 'editor.toggleLineComment',
      title: 'Toggle Line Comment',
      category: 'Editor',
      defaultKeys: { intellij: 'Ctrl+/', vscode: 'Ctrl+/' },
      allowInInputs: true, // Monaco input is a textarea
      run: () => trigger('editor.action.commentLine'),
    },
    {
      id: 'editor.toggleBlockComment',
      title: 'Toggle Block Comment',
      category: 'Editor',
      defaultKeys: { intellij: 'Ctrl+Shift+/', vscode: 'Alt+Shift+A' },
      allowInInputs: true,
      run: () => trigger('editor.action.blockComment'),
    },
    {
      id: 'editor.toggleCase',
      title: 'Toggle Case',
      category: 'Editor',
      defaultKeys: { intellij: 'Ctrl+Shift+U' },
      allowInInputs: true,
      run: toggleCase,
    },
    {
      id: 'editor.organizeImports',
      title: 'Organize Imports',
      category: 'Editor',
      defaultKeys: { intellij: 'Ctrl+Alt+O', vscode: 'Alt+Shift+O' },
      allowInInputs: true, // Monaco input is a textarea
      run: () => void organizeImportsInActiveEditor(),
    },
  ]);
  return () => {
    unregister();
    unregisterNav();
    unregisterAi();
  };
}
