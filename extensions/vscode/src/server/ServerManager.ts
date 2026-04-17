import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  SERVER_ENTRY_RELATIVE,
  SERVER_POLL_INTERVAL_MS,
  SERVER_START_TIMEOUT_MS,
  ENV_PORT_KEY,
} from '../constants';
import { ApiClient } from './ApiClient';

export class ServerManager implements vscode.Disposable {
  private process: cp.ChildProcess | null = null;
  private readonly client: ApiClient;

  constructor(private readonly port: number, private readonly outputChannel: vscode.OutputChannel) {
    this.client = new ApiClient(DEFAULT_HOST, port);
  }

  get apiClient(): ApiClient {
    return this.client;
  }

  async ensureRunning(): Promise<void> {
    if (await this.client.isAlive()) {
      return;
    }

    const serverPath = this.resolveServerPath();
    if (!serverPath) {
      vscode.window.showWarningMessage(
        'MCP server binary not found. Run `npm run build` in the MCP project first.',
      );
      return;
    }

    this.outputChannel.appendLine(`Starting MCP server on port ${this.port}...`);
    this.process = cp.spawn('node', [serverPath], {
      env: { ...process.env, [ENV_PORT_KEY]: String(this.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    this.process.stdout?.on('data', (d: Buffer) => this.outputChannel.append(d.toString()));
    this.process.stderr?.on('data', (d: Buffer) => this.outputChannel.append(d.toString()));
    this.process.on('exit', (code) => this.outputChannel.appendLine(`MCP server exited (code ${code})`));

    await this.waitForServer();
    this.outputChannel.appendLine('MCP server is ready.');
  }

  private resolveServerPath(): string | null {
    const config = vscode.workspace.getConfiguration('mcp');
    const manual: string = config.get('serverBinaryPath', '');
    if (manual && fs.existsSync(manual)) {
      return manual;
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const candidate = path.join(folder.uri.fsPath, SERVER_ENTRY_RELATIVE);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private waitForServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
      const poll = setInterval(async () => {
        if (await this.client.isAlive()) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error('MCP server did not start in time'));
        }
      }, SERVER_POLL_INTERVAL_MS);
    });
  }

  dispose(): void {
    if (this.process && !this.process.killed) {
      this.process.kill();
      this.process = null;
    }
  }
}
