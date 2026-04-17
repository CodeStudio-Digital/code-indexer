import * as vscode from 'vscode';
import { DEFAULT_PORT } from './constants';
import { ServerManager } from './server/ServerManager';
import { StatusBarManager } from './ui/StatusBarManager';
import { openChatCommand } from './commands/OpenChatCommand';
import { searchCommand } from './commands/SearchCommand';
import { indexProjectCommand } from './commands/IndexCommand';

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('mcp');
  const port: number = config.get('serverPort', DEFAULT_PORT);
  const autoStart: boolean = config.get('autoStartServer', true);

  const output = vscode.window.createOutputChannel('MCP Code Indexer');
  const serverManager = new ServerManager(port, output);
  const statusBar = new StatusBarManager(serverManager.apiClient, port);

  context.subscriptions.push(
    output,
    serverManager,
    statusBar,

    vscode.commands.registerCommand('mcp.openChat', () =>
      openChatCommand(serverManager, port),
    ),

    vscode.commands.registerCommand('mcp.search', () =>
      searchCommand(serverManager, serverManager.apiClient),
    ),

    vscode.commands.registerCommand('mcp.indexProject', () =>
      indexProjectCommand(serverManager, serverManager.apiClient),
    ),
  );

  if (autoStart) {
    serverManager.ensureRunning().then(() => statusBar.startPolling());
  } else {
    statusBar.startPolling();
  }
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions are cleaned up automatically.
}
