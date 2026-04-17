import * as vscode from 'vscode';
import * as path from 'path';
import { ApiClient, SearchResult } from '../server/ApiClient';
import { ServerManager } from '../server/ServerManager';
import { SEARCH_DEBOUNCE_MS } from '../constants';

function buildQuickPickItem(result: SearchResult): vscode.QuickPickItem & { filePath?: string; line?: number } {
  const isFile = result.type === 'file';
  return {
    label: isFile
      ? `$(file-code) ${path.basename(result.data.path ?? '')}`
      : `$(symbol-method) ${result.data.name ?? ''}`,
    description: isFile ? result.data.path : `${result.data.kind} — ${result.data.path}`,
    detail: result.data.summary ?? undefined,
    filePath: result.data.path,
    line: undefined,
  };
}

export async function searchCommand(serverManager: ServerManager, client: ApiClient): Promise<void> {
  await serverManager.ensureRunning();

  const selectedText = vscode.window.activeTextEditor?.document
    .getText(vscode.window.activeTextEditor.selection)
    .trim();

  const quickPick = vscode.window.createQuickPick<ReturnType<typeof buildQuickPickItem>>();
  quickPick.placeholder = 'Search codebase (files, symbols, concepts)…';
  quickPick.value = selectedText ?? '';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  let debounce: ReturnType<typeof setTimeout> | undefined;

  const doSearch = (query: string): void => {
    if (debounce) clearTimeout(debounce);
    if (!query.trim()) {
      quickPick.items = [];
      return;
    }
    debounce = setTimeout(async () => {
      quickPick.busy = true;
      try {
        const results = await client.search(query);
        quickPick.items = results.map(buildQuickPickItem);
      } catch {
        quickPick.items = [];
      } finally {
        quickPick.busy = false;
      }
    }, SEARCH_DEBOUNCE_MS);
  };

  quickPick.onDidChangeValue(doSearch);

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    quickPick.hide();
    if (!selected?.filePath) return;

    try {
      const doc = await vscode.workspace.openTextDocument(selected.filePath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      vscode.window.showErrorMessage(`Could not open file: ${selected.filePath}`);
    }
  });

  quickPick.show();
  if (selectedText) {
    doSearch(selectedText);
  }
}
