import * as vscode from 'vscode';
import { ApiClient } from '../server/ApiClient';
import { ServerManager } from '../server/ServerManager';

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export async function indexProjectCommand(serverManager: ServerManager, client: ApiClient): Promise<void> {
  await serverManager.ensureRunning();

  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('No workspace folder is open.');
    return;
  }

  const rootPath = folders[0].uri.fsPath;
  const projectName = folders[0].name;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `MCP: Indexing "${projectName}"`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Looking up project…' });

      let project = await client.findProjectByPath(rootPath);
      if (!project) {
        progress.report({ message: 'Creating project…' });
        project = await client.createProject(rootPath, projectName);
      }

      progress.report({ message: 'Starting indexing run…' });
      await client.indexProject(project.id, DEFAULT_PROVIDER, DEFAULT_MODEL);

      vscode.window.showInformationMessage(
        `MCP: Indexing started for "${projectName}". Monitor progress in the status bar.`,
      );
    },
  );
}
