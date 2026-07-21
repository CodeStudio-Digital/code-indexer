/**
 * Static command catalogue + runtime handlers.
 *
 * Metadata is intentionally independent from mounted React surfaces: every
 * built-in action remains discoverable/remappable even when no project or
 * editor is open. Surfaces only attach handlers for the actions they can run.
 */

export type CommandTarget = 'workbench' | 'project' | 'editor';
export type CommandCategory =
  | 'Workbench' | 'File' | 'Navigate' | 'Search' | 'Edit'
  | 'Selection' | 'Code' | 'Refactor' | 'Problems' | 'Folding' | 'AI';

export interface CommandSpec {
  id: string;
  title: string;
  titlePt: string;
  category: CommandCategory | string;
  categoryPt?: string;
  target: CommandTarget;
  defaultKeys?: { intellij?: string[]; vscode?: string[] };
  /** Monaco context expression shown in Keymap and used by Monaco rules. */
  context?: string;
  /** The underlying Monaco action, when the command is a direct proxy. */
  monacoCommand?: string;
  /** Allow the global dispatcher to fire while an input/editor textarea owns focus. */
  allowInInputs?: boolean;
}

export interface CommandHandler {
  run: () => void | Promise<void>;
  when?: () => boolean;
}

export interface CommandDef extends CommandSpec {
  handler?: CommandHandler;
  available: boolean;
}

const keys = (intellij?: string | string[], vscode?: string | string[]) => ({
  intellij: intellij ? (Array.isArray(intellij) ? intellij : [intellij]) : undefined,
  vscode: vscode ? (Array.isArray(vscode) ? vscode : [vscode]) : undefined,
});

const E = 'editorTextFocus';

/** The single built-in source of truth used by Settings, dispatch and Monaco. */
export const COMMAND_CATALOG: readonly CommandSpec[] = [
  { id: 'workbench.commandPalette', title: 'Command Palette', titlePt: 'Paleta de comandos', category: 'Workbench', categoryPt: 'Área de trabalho', target: 'workbench', defaultKeys: keys('Ctrl+K', 'Ctrl+K'), allowInInputs: true },
  { id: 'navigate.searchEverywhere', title: 'Search Everywhere', titlePt: 'Buscar em todo lugar', category: 'Search', categoryPt: 'Busca', target: 'project', defaultKeys: keys('Shift Shift', 'Ctrl+T') },
  { id: 'navigate.file', title: 'Go to File', titlePt: 'Ir para arquivo', category: 'Navigate', categoryPt: 'Navegação', target: 'project', defaultKeys: keys('Ctrl+Shift+N', 'Ctrl+P') },
  { id: 'navigate.symbol', title: 'Go to Symbol', titlePt: 'Ir para símbolo', category: 'Navigate', categoryPt: 'Navegação', target: 'project', defaultKeys: keys('Ctrl+N', 'Ctrl+Shift+O') },
  { id: 'navigate.textSearch', title: 'Find in Files', titlePt: 'Localizar nos arquivos', category: 'Search', categoryPt: 'Busca', target: 'project', defaultKeys: keys('Ctrl+Shift+F', 'Ctrl+Shift+F') },
  { id: 'navigate.commands', title: 'Find Action', titlePt: 'Localizar ação', category: 'Search', categoryPt: 'Busca', target: 'project', defaultKeys: keys('Ctrl+Shift+A', 'Ctrl+Shift+P') },
  { id: 'navigate.recentFiles', title: 'Recent Files', titlePt: 'Arquivos recentes', category: 'Navigate', categoryPt: 'Navegação', target: 'project', defaultKeys: keys('Ctrl+E', 'Ctrl+E') },
  { id: 'navigate.fileStructure', title: 'File Structure', titlePt: 'Estrutura do arquivo', category: 'Navigate', categoryPt: 'Navegação', target: 'project', defaultKeys: keys('Ctrl+F12', 'Ctrl+Shift+O') },
  { id: 'navigate.line', title: 'Go to Line', titlePt: 'Ir para linha', category: 'Navigate', categoryPt: 'Navegação', target: 'editor', defaultKeys: keys('Ctrl+G', 'Ctrl+G'), allowInInputs: true },
  { id: 'navigate.back', title: 'Back', titlePt: 'Voltar', category: 'Navigate', categoryPt: 'Navegação', target: 'editor', defaultKeys: keys('Ctrl+Alt+Left', 'Alt+Left'), allowInInputs: true },
  { id: 'navigate.forward', title: 'Forward', titlePt: 'Avançar', category: 'Navigate', categoryPt: 'Navegação', target: 'editor', defaultKeys: keys('Ctrl+Alt+Right', 'Alt+Right'), allowInInputs: true },
  { id: 'file.save', title: 'Save File', titlePt: 'Salvar arquivo', category: 'File', categoryPt: 'Arquivo', target: 'project', defaultKeys: keys('Ctrl+S', 'Ctrl+S'), allowInInputs: true },
  { id: 'file.saveAll', title: 'Save All', titlePt: 'Salvar tudo', category: 'File', categoryPt: 'Arquivo', target: 'project', defaultKeys: keys('Ctrl+Shift+S', 'Ctrl+Shift+S'), allowInInputs: true },
  { id: 'file.closeTab', title: 'Close Tab', titlePt: 'Fechar aba', category: 'File', categoryPt: 'Arquivo', target: 'project', defaultKeys: keys('Ctrl+F4', 'Ctrl+W') },
  { id: 'view.toggleTerminal', title: 'Toggle Terminal', titlePt: 'Alternar terminal', category: 'Workbench', categoryPt: 'Área de trabalho', target: 'project', defaultKeys: keys('Alt+F12', 'Ctrl+J') },
  { id: 'view.toggleProjectTree', title: 'Toggle Project Files', titlePt: 'Alternar arquivos do projeto', category: 'Workbench', categoryPt: 'Área de trabalho', target: 'project', defaultKeys: keys('Alt+1', 'Ctrl+B') },
  { id: 'view.toggleChat', title: 'Toggle Agent Chat', titlePt: 'Alternar chat do agente', category: 'Workbench', categoryPt: 'Área de trabalho', target: 'project', defaultKeys: keys('Alt+2', 'Ctrl+Alt+B') },
  { id: 'view.keymapSettings', title: 'Keymap Settings', titlePt: 'Configurações do mapa de teclas', category: 'Workbench', categoryPt: 'Área de trabalho', target: 'project', defaultKeys: keys('Ctrl+Alt+S', 'Ctrl+K Ctrl+S') },
  { id: 'view.splitEditorRight', title: 'Split Editor Right', titlePt: 'Dividir editor à direita', category: 'Workbench', categoryPt: 'Área de trabalho', target: 'project' },
  { id: 'view.splitEditorDown', title: 'Split Editor Down', titlePt: 'Dividir editor abaixo', category: 'Workbench', categoryPt: 'Área de trabalho', target: 'project' },
  { id: 'view.unsplitEditor', title: 'Unsplit Editor', titlePt: 'Remover divisão do editor', category: 'Workbench', categoryPt: 'Área de trabalho', target: 'project' },

  { id: 'database.runQuery', title: 'Run Query or Selection', titlePt: 'Executar consulta ou seleção', category: 'Run', categoryPt: 'Executar', target: 'editor', defaultKeys: keys('Ctrl+Enter', 'Ctrl+Enter'), context: 'sqlEditorFocus', allowInInputs: true },
  { id: 'database.runAllQueries', title: 'Run All Queries', titlePt: 'Executar todas as consultas', category: 'Run', categoryPt: 'Executar', target: 'editor', defaultKeys: keys('Ctrl+Shift+Enter', 'Ctrl+Shift+Enter'), context: 'sqlEditorFocus', allowInInputs: true },
  { id: 'database.formatQuery', title: 'Format Query', titlePt: 'Formatar consulta', category: 'Code', target: 'editor', defaultKeys: keys('Ctrl+Alt+L', 'Shift+Alt+F'), context: 'sqlEditorFocus', allowInInputs: true },

  { id: 'editor.toggleLineComment', title: 'Toggle Line Comment', titlePt: 'Comentar/descomentar linha', category: 'Code', target: 'editor', defaultKeys: keys('Ctrl+/', 'Ctrl+/'), context: E, monacoCommand: 'editor.action.commentLine', allowInInputs: true },
  { id: 'editor.toggleBlockComment', title: 'Toggle Block Comment', titlePt: 'Comentar/descomentar bloco', category: 'Code', target: 'editor', defaultKeys: keys('Ctrl+Shift+/', 'Alt+Shift+A'), context: E, monacoCommand: 'editor.action.blockComment', allowInInputs: true },
  { id: 'editor.format', title: 'Reformat Code', titlePt: 'Reformatar código', category: 'Code', target: 'editor', defaultKeys: keys('Ctrl+Alt+L', 'Shift+Alt+F'), context: 'editorTextFocus && !sqlEditorFocus', allowInInputs: true },
  { id: 'editor.organizeImports', title: 'Optimize Imports', titlePt: 'Otimizar imports', category: 'Code', target: 'editor', defaultKeys: keys('Ctrl+Alt+O', 'Alt+Shift+O'), context: E, allowInInputs: true },
  { id: 'editor.quickFix', title: 'Show Context Actions', titlePt: 'Mostrar ações de contexto', category: 'Code', target: 'editor', defaultKeys: keys('Alt+Enter', 'Ctrl+.'), context: E, monacoCommand: 'editor.action.quickFix', allowInInputs: true },
  { id: 'editor.triggerSuggest', title: 'Show Suggestions', titlePt: 'Mostrar sugestões', category: 'Code', target: 'editor', defaultKeys: keys('Ctrl+Space', 'Ctrl+Space'), context: E, monacoCommand: 'editor.action.triggerSuggest', allowInInputs: true },
  { id: 'editor.parameterHints', title: 'Parameter Info', titlePt: 'Informações de parâmetros', category: 'Code', target: 'editor', defaultKeys: keys('Ctrl+P', 'Ctrl+Shift+Space'), context: E, monacoCommand: 'editor.action.triggerParameterHints', allowInInputs: true },
  { id: 'editor.showHover', title: 'Quick Documentation', titlePt: 'Documentação rápida', category: 'Code', target: 'editor', defaultKeys: keys('Ctrl+Q', 'Ctrl+K Ctrl+I'), context: E, monacoCommand: 'editor.action.showHover', allowInInputs: true },
  { id: 'editor.duplicateLine', title: 'Duplicate Line or Selection', titlePt: 'Duplicar linha ou seleção', category: 'Edit', target: 'editor', defaultKeys: keys('Ctrl+D', 'Shift+Alt+Down'), context: E, monacoCommand: 'editor.action.copyLinesDownAction', allowInInputs: true },
  { id: 'editor.deleteLine', title: 'Delete Line', titlePt: 'Excluir linha', category: 'Edit', target: 'editor', defaultKeys: keys('Ctrl+Y', 'Ctrl+Shift+K'), context: E, monacoCommand: 'editor.action.deleteLines', allowInInputs: true },
  { id: 'editor.moveLineUp', title: 'Move Line Up', titlePt: 'Mover linha para cima', category: 'Edit', target: 'editor', defaultKeys: keys(['Alt+Shift+Up', 'Ctrl+Shift+Up'], 'Alt+Up'), context: E, monacoCommand: 'editor.action.moveLinesUpAction', allowInInputs: true },
  { id: 'editor.moveLineDown', title: 'Move Line Down', titlePt: 'Mover linha para baixo', category: 'Edit', target: 'editor', defaultKeys: keys(['Alt+Shift+Down', 'Ctrl+Shift+Down'], 'Alt+Down'), context: E, monacoCommand: 'editor.action.moveLinesDownAction', allowInInputs: true },
  { id: 'editor.joinLines', title: 'Join Lines', titlePt: 'Unir linhas', category: 'Edit', target: 'editor', defaultKeys: keys('Ctrl+Shift+J'), context: E, monacoCommand: 'editor.action.joinLines', allowInInputs: true },
  { id: 'editor.toggleCase', title: 'Toggle Case', titlePt: 'Alternar maiúsculas/minúsculas', category: 'Edit', target: 'editor', defaultKeys: keys('Ctrl+Shift+U'), context: E, allowInInputs: true },
  { id: 'editor.expandSelection', title: 'Extend Selection', titlePt: 'Expandir seleção', category: 'Selection', categoryPt: 'Seleção', target: 'editor', defaultKeys: keys('Ctrl+W', 'Shift+Alt+Right'), context: E, monacoCommand: 'editor.action.smartSelect.expand', allowInInputs: true },
  { id: 'editor.shrinkSelection', title: 'Shrink Selection', titlePt: 'Reduzir seleção', category: 'Selection', categoryPt: 'Seleção', target: 'editor', defaultKeys: keys('Ctrl+Shift+W', 'Shift+Alt+Left'), context: E, monacoCommand: 'editor.action.smartSelect.shrink', allowInInputs: true },
  { id: 'editor.addNextOccurrence', title: 'Add Selection for Next Occurrence', titlePt: 'Adicionar próxima ocorrência à seleção', category: 'Selection', categoryPt: 'Seleção', target: 'editor', defaultKeys: keys(['Alt+J', 'Ctrl+Shift+D'], 'Ctrl+D'), context: E, monacoCommand: 'editor.action.addSelectionToNextFindMatch', allowInInputs: true },
  { id: 'editor.selectAllOccurrences', title: 'Select All Occurrences', titlePt: 'Selecionar todas as ocorrências', category: 'Selection', categoryPt: 'Seleção', target: 'editor', defaultKeys: keys('Ctrl+Alt+Shift+J', 'Ctrl+Shift+L'), context: E, monacoCommand: 'editor.action.selectHighlights', allowInInputs: true },
  { id: 'editor.cursorAbove', title: 'Add Cursor Above', titlePt: 'Adicionar cursor acima', category: 'Selection', categoryPt: 'Seleção', target: 'editor', defaultKeys: keys('Ctrl+Alt+Up', 'Ctrl+Alt+Up'), context: E, monacoCommand: 'editor.action.insertCursorAbove', allowInInputs: true },
  { id: 'editor.cursorBelow', title: 'Add Cursor Below', titlePt: 'Adicionar cursor abaixo', category: 'Selection', categoryPt: 'Seleção', target: 'editor', defaultKeys: keys('Ctrl+Alt+Down', 'Ctrl+Alt+Down'), context: E, monacoCommand: 'editor.action.insertCursorBelow', allowInInputs: true },
  { id: 'editor.definition', title: 'Go to Definition', titlePt: 'Ir para definição', category: 'Navigate', categoryPt: 'Navegação', target: 'editor', defaultKeys: keys('Ctrl+B', 'F12'), context: E, monacoCommand: 'editor.action.revealDefinition', allowInInputs: true },
  { id: 'editor.implementation', title: 'Go to Implementation', titlePt: 'Ir para implementação', category: 'Navigate', categoryPt: 'Navegação', target: 'editor', defaultKeys: keys('Ctrl+Alt+B', 'Ctrl+F12'), context: E, monacoCommand: 'editor.action.goToImplementation', allowInInputs: true },
  { id: 'editor.references', title: 'Find Usages', titlePt: 'Localizar usos', category: 'Navigate', categoryPt: 'Navegação', target: 'editor', defaultKeys: keys('Alt+F7', 'Shift+F12'), context: E, monacoCommand: 'editor.action.goToReferences', allowInInputs: true },
  { id: 'editor.rename', title: 'Rename Symbol', titlePt: 'Renomear símbolo', category: 'Refactor', categoryPt: 'Refatoração', target: 'editor', defaultKeys: keys('Shift+F6', 'F2'), context: E, monacoCommand: 'editor.action.rename', allowInInputs: true },
  { id: 'editor.nextProblem', title: 'Next Problem', titlePt: 'Próximo problema', category: 'Problems', categoryPt: 'Problemas', target: 'editor', defaultKeys: keys('F2', 'F8'), context: E, monacoCommand: 'mcp.editor.problem.next', allowInInputs: true },
  { id: 'editor.previousProblem', title: 'Previous Problem', titlePt: 'Problema anterior', category: 'Problems', categoryPt: 'Problemas', target: 'editor', defaultKeys: keys('Shift+F2', 'Shift+F8'), context: E, monacoCommand: 'mcp.editor.problem.previous', allowInInputs: true },
  { id: 'editor.nextChange', title: 'Next Change', titlePt: 'Próxima alteração', category: 'Navigate', categoryPt: 'Navegação', target: 'editor', defaultKeys: keys('Ctrl+Alt+Shift+Down', 'Ctrl+Alt+Shift+Down'), allowInInputs: true },
  { id: 'editor.prevChange', title: 'Previous Change', titlePt: 'Alteração anterior', category: 'Navigate', categoryPt: 'Navegação', target: 'editor', defaultKeys: keys('Ctrl+Alt+Shift+Up', 'Ctrl+Alt+Shift+Up'), allowInInputs: true },
  { id: 'editor.fold', title: 'Collapse Region', titlePt: 'Recolher região', category: 'Folding', target: 'editor', defaultKeys: keys('Ctrl+-', 'Ctrl+Shift+['), context: E, monacoCommand: 'editor.fold', allowInInputs: true },
  { id: 'editor.unfold', title: 'Expand Region', titlePt: 'Expandir região', category: 'Folding', target: 'editor', defaultKeys: keys('Ctrl++', 'Ctrl+Shift+]'), context: E, monacoCommand: 'editor.unfold', allowInInputs: true },
  { id: 'editor.foldAll', title: 'Collapse All', titlePt: 'Recolher tudo', category: 'Folding', target: 'editor', defaultKeys: keys('Ctrl+Shift+-', 'Ctrl+K Ctrl+0'), context: E, monacoCommand: 'editor.foldAll', allowInInputs: true },
  { id: 'editor.unfoldAll', title: 'Expand All', titlePt: 'Expandir tudo', category: 'Folding', target: 'editor', defaultKeys: keys('Ctrl+Shift++', 'Ctrl+K Ctrl+J'), context: E, monacoCommand: 'editor.unfoldAll', allowInInputs: true },
  { id: 'editor.aiComplete.triggerSuggest', title: 'Trigger AI Completion', titlePt: 'Acionar completion por IA', category: 'AI', target: 'editor', defaultKeys: keys('Alt+\\', 'Alt+\\'), context: E, allowInInputs: true },
  { id: 'editor.aiComplete.acceptNextLine', title: 'Accept Next AI Completion Line', titlePt: 'Aceitar próxima linha da completion por IA', category: 'AI', target: 'editor', defaultKeys: keys('Ctrl+Shift+Right', 'Ctrl+Shift+Right'), context: 'inlineSuggestionVisible && editorTextFocus', monacoCommand: 'editor.action.inlineSuggest.acceptNextLine', allowInInputs: true },
  { id: 'editor.aiComplete.toggle', title: 'Toggle AI Completion', titlePt: 'Alternar completion por IA', category: 'AI', target: 'editor' },
  { id: 'editor.addSelectionToChat', title: 'Add Selection to Chat', titlePt: 'Adicionar seleção ao chat', category: 'AI', target: 'editor', defaultKeys: keys('Ctrl+I', 'Ctrl+I'), context: E, allowInInputs: true },
  { id: 'editor.addFileToChat', title: 'Add File to Chat', titlePt: 'Adicionar arquivo ao chat', category: 'AI', target: 'editor', context: E, allowInInputs: true },
  { id: 'editor.semanticSearch', title: 'Find Semantically Related Code', titlePt: 'Buscar código semanticamente relacionado', category: 'Search', categoryPt: 'Busca', target: 'editor', context: E, monacoCommand: 'mcp.semanticSearch', allowInInputs: true },
  { id: 'run.file', title: 'Run File', titlePt: 'Executar arquivo', category: 'Run', categoryPt: 'Executar', target: 'editor', defaultKeys: keys('Shift+F10', 'Shift+F10'), context: E, allowInInputs: true },
  { id: 'debug.selected', title: 'Debug Selected Configuration', titlePt: 'Depurar configuração selecionada', category: 'Run', categoryPt: 'Executar', target: 'project', defaultKeys: keys('Shift+F9', 'F5'), allowInInputs: true },
];

const specs = new Map(COMMAND_CATALOG.map((spec) => [spec.id, spec]));
const handlers = new Map<string, CommandHandler>();
const dynamicIds = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* observers never break the command layer */ }
  }
}

export function onCommandsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerCommandHandlers(entries: Array<{ id: string } & CommandHandler>): () => void {
  for (const { id, ...handler } of entries) handlers.set(id, handler);
  notify();
  return () => {
    for (const entry of entries) {
      const current = handlers.get(entry.id);
      if (current?.run === entry.run) handlers.delete(entry.id);
    }
    notify();
  };
}

/** Extension point for plugin-contributed commands. Built-ins use handlers only. */
export function registerCommands(defs: Array<CommandSpec & CommandHandler>): () => void {
  for (const { run, when, ...spec } of defs) {
    specs.set(spec.id, spec);
    handlers.set(spec.id, { run, when });
    dynamicIds.add(spec.id);
  }
  notify();
  return () => {
    for (const def of defs) {
      if (dynamicIds.has(def.id)) {
        specs.delete(def.id);
        handlers.delete(def.id);
        dynamicIds.delete(def.id);
      }
    }
    notify();
  };
}

export function listCommands(): CommandDef[] {
  return [...specs.values()].map((spec) => {
    const handler = handlers.get(spec.id);
    return { ...spec, handler, available: !!handler && (!handler.when || handler.when()) };
  });
}

export function getCommand(id: string): CommandDef | undefined {
  const spec = specs.get(id);
  if (!spec) return undefined;
  const handler = handlers.get(id);
  return { ...spec, handler, available: !!handler && (!handler.when || handler.when()) };
}

export function executeCommand(id: string): boolean {
  const handler = handlers.get(id);
  if (!handler || (handler.when && !handler.when())) return false;
  void handler.run();
  return true;
}
