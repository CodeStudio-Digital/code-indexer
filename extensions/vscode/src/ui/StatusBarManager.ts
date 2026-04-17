import * as vscode from 'vscode';
import { STATUS_POLL_INTERVAL_MS } from '../constants';
import { ApiClient } from '../server/ApiClient';

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly client: ApiClient, private readonly port: number) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.item.command = 'mcp.openChat';
    this.item.tooltip = 'Open MCP Agent Chat';
    this.item.show();
    this.setDisconnected();
  }

  startPolling(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), STATUS_POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    const alive = await this.client.isAlive();
    if (!alive) {
      this.setDisconnected();
      return;
    }

    try {
      const projects = await this.client.listProjects();
      const indexing = projects.some((p) => !p.last_indexed);
      if (indexing) {
        this.setIndexing();
      } else {
        this.setConnected(projects.length);
      }
    } catch {
      this.setConnected(0);
    }
  }

  private setConnected(projectCount: number): void {
    this.item.text = `$(database) MCP :${this.port} (${projectCount} projects)`;
    this.item.backgroundColor = undefined;
  }

  private setIndexing(): void {
    this.item.text = `$(sync~spin) MCP Indexing...`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  private setDisconnected(): void {
    this.item.text = `$(circle-slash) MCP Offline`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.item.dispose();
  }
}
