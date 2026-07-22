/** One running LSP server instance; the manager owns restart policy. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLspInitializeParams } from './lsp-client-capabilities.js';
import { LspRpcClient } from './lsp-client.js';
import { spawnLspProcess } from './lsp-handle-process.js';
import { LspHandleRequests } from './lsp-handle-requests.js';
import {
  LspRequestScheduler,
  type LspRequestSchedulerStats,
} from './lsp-request-scheduler.js';
import {
  pathToUri,
  uriToPath,
  toLsp,
  type LspDiagnostic,
  type SemanticTokensLegend,
  type ServerCapabilities,
} from './lsp-protocol.js';

export { ADVANCED_TEXT_DOCUMENT_CAPABILITIES } from './lsp-client-capabilities.js';

export type LspHandleState = 'starting' | 'ready' | 'stopped' | 'crashed';
type Position = { line: number; column: number };
type Range = { start: Position; end: Position };
type FormattingOptions = { tabSize: number; insertSpaces: boolean };

export interface LspSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  priority?: number;
  rootPath: string;
  initializationOptions?: unknown;
  workspaceFolders?: boolean;
  initializeTimeoutMs?: number;
  resolveConfig?: (section: string | null) => unknown;
}

const INIT_TIMEOUT_MS = 30_000;
const STDERR_RING = 8 * 1024;

export class LspServerHandle {
  state: LspHandleState = 'starting';
  capabilities: ServerCapabilities = {};
  stderrTail = '';
  private opened = new Set<string>();
  private child: ChildProcessWithoutNullStreams;
  private rpc: LspRpcClient;
  private scheduler = new LspRequestScheduler();
  private requestFacade?: LspHandleRequests;
  private readyPromise: Promise<void>;
  private commandWorkspaceEdits: unknown[] | null = null;

  constructor(
    private spec: LspSpawnSpec,
    private hooks: {
      onDiagnostics: (absPath: string, diagnostics: LspDiagnostic[]) => void;
      onExit: (code: number | null) => void;
      log: (msg: string) => void;
    },
  ) {
    const processHandle = spawnLspProcess(spec, hooks.log);
    this.child = processHandle.child;
    this.rpc = new LspRpcClient(this.child, hooks.log, spec.resolveConfig, (edit) => {
      if (!this.commandWorkspaceEdits) return false;
      this.commandWorkspaceEdits.push(edit);
      return true;
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf-8')).slice(-STDERR_RING);
    });
    this.child.on('exit', (code) => {
      processHandle.untrack();
      const wasStopped = this.state === 'stopped';
      this.state = wasStopped ? 'stopped' : 'crashed';
      this.rpc.dispose(`lsp server exited (code ${code})`);
      if (!wasStopped) hooks.onExit(code);
    });
    this.child.on('error', (error) => {
      processHandle.untrack();
      hooks.log(`spawn error: ${error.message}`);
      this.state = 'crashed';
      this.rpc.dispose(`lsp server spawn error: ${error.message}`);
      hooks.onExit(null);
    });

    this.rpc.onNotification('textDocument/publishDiagnostics', (params) => {
      const payload = params as { uri: string; diagnostics: LspDiagnostic[] };
      if (payload?.uri) hooks.onDiagnostics(uriToPath(payload.uri), payload.diagnostics ?? []);
    });
    this.rpc.onNotification('window/logMessage', (params) => {
      const message = (params as { message?: unknown })?.message;
      if (typeof message === 'string') hooks.log(message);
    });
    this.readyPromise = this.initialize();
  }

  whenReady(): Promise<void> { return this.readyPromise; }

  private async initialize(): Promise<void> {
    const rootUri = pathToUri(this.spec.rootPath);
    const result = await this.rpc.request<{ capabilities?: ServerCapabilities }>(
      'initialize',
      createLspInitializeParams({
        rootUri,
        workspaceFolders: this.spec.workspaceFolders,
        initializationOptions: this.spec.initializationOptions,
      }),
      this.spec.initializeTimeoutMs ?? INIT_TIMEOUT_MS,
    );
    this.capabilities = result?.capabilities ?? {};
    this.rpc.notify('initialized', {});
    this.state = 'ready';
  }

  private get supportsIncremental(): boolean {
    const sync = this.capabilities.textDocumentSync;
    const change = typeof sync === 'number' ? sync : sync?.change;
    return change === 2;
  }

  private get requests(): LspHandleRequests {
    return this.requestFacade ??= new LspHandleRequests(this.rpc, this.scheduler);
  }

  didOpen(absPath: string, languageId: string, version: number, text: string): void {
    const uri = pathToUri(absPath);
    this.opened.add(uri);
    this.rpc.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
  }

  ensureOpen(absPath: string, languageId: string, version: number, text: string): void {
    if (this.opened.has(pathToUri(absPath))) return;
    this.didOpen(absPath, languageId, version, text);
  }

  didChange(
    absPath: string,
    version: number,
    fullText: string,
    changes: Array<{ start: Position; end: Position; text: string }>,
  ): void {
    const uri = pathToUri(absPath);
    const contentChanges = this.supportsIncremental
      ? changes.map((change) => ({
          range: { start: toLsp(change.start), end: toLsp(change.end) },
          text: change.text,
        }))
      : [{ text: fullText }];
    this.rpc.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges,
    });
  }

  didClose(absPath: string): void {
    const uri = pathToUri(absPath);
    this.opened.delete(uri);
    this.rpc.notify('textDocument/didClose', { textDocument: { uri } });
  }

  requestStats(): LspRequestSchedulerStats { return this.scheduler.stats(); }

  completion(
    absPath: string,
    position: Position,
    context?: { triggerKind: number; triggerCharacter?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requests.completion(absPath, position, context, signal);
  }

  resolveCompletion(item: unknown, signal?: AbortSignal): Promise<unknown> { return this.requests.resolveCompletion(item, signal); }

  hover(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> { return this.requests.hover(absPath, position, signal); }

  definition(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> { return this.requests.definition(absPath, position, signal); }

  supportsTypeDefinition(): boolean { return !!this.capabilities.typeDefinitionProvider; }

  typeDefinition(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> { return this.requests.typeDefinition(absPath, position, signal); }

  supportsFoldingRanges(): boolean { return !!this.capabilities.foldingRangeProvider; }

  foldingRanges(absPath: string, signal?: AbortSignal): Promise<unknown> { return this.requests.foldingRanges(absPath, signal); }

  supportsInlayHints(): boolean { return !!this.capabilities.inlayHintProvider; }

  inlayHints(absPath: string, range: Range, signal?: AbortSignal): Promise<unknown> {
    return this.requests.inlayHints(absPath, range, signal);
  }

  supportsLinkedEditingRanges(): boolean { return !!this.capabilities.linkedEditingRangeProvider; }

  linkedEditingRanges(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.requests.linkedEditingRanges(absPath, position, signal);
  }

  references(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.requests.references(absPath, position, signal);
  }

  rename(absPath: string, position: Position, newName: string, signal?: AbortSignal): Promise<unknown> {
    return this.requests.rename(absPath, position, newName, signal);
  }

  signatureHelp(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.requests.signatureHelp(absPath, position, signal);
  }

  documentSymbol(absPath: string, signal?: AbortSignal): Promise<unknown> { return this.requests.documentSymbol(absPath, signal); }

  codeActions(
    absPath: string,
    range: Range,
    only?: string[],
    options: { origin?: 'auto' | 'invoke'; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return this.requests.codeActions(absPath, range, only, options);
  }

  supportsCodeActionResolve(): boolean {
    const provider = this.capabilities.codeActionProvider;
    return typeof provider === 'object' && provider.resolveProvider === true;
  }

  resolveCodeAction(action: unknown, signal?: AbortSignal): Promise<unknown> { return this.requests.resolveCodeAction(action, signal); }

  async executeCommand(
    command: string,
    args?: unknown[],
    signal?: AbortSignal,
  ): Promise<{ result: unknown; workspaceEdits: unknown[] }> {
    const advertised = this.capabilities.executeCommandProvider?.commands ?? [];
    if (advertised.length > 0 && !advertised.includes(command)) {
      return Promise.reject(new Error(`LSP command not advertised: ${command}`));
    }
    if (this.commandWorkspaceEdits) {
      throw new Error('another LSP code-action command is already running');
    }
    const workspaceEdits: unknown[] = [];
    this.commandWorkspaceEdits = workspaceEdits;
    try {
      const result = await this.requests.executeCommand(command, args, signal);
      return { result, workspaceEdits };
    } finally {
      this.commandWorkspaceEdits = null;
    }
  }

  implementation(absPath: string, position: Position, signal?: AbortSignal): Promise<unknown> {
    return this.requests.implementation(absPath, position, signal);
  }

  formatting(absPath: string, options: FormattingOptions, signal?: AbortSignal): Promise<unknown> {
    return this.requests.formatting(absPath, options, signal);
  }

  rangeFormatting(
    absPath: string,
    range: Range,
    options: FormattingOptions,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requests.rangeFormatting(absPath, range, options, signal);
  }

  semanticTokens(absPath: string, signal?: AbortSignal): Promise<unknown> { return this.requests.semanticTokens(absPath, signal); }

  semanticTokensLegend(): SemanticTokensLegend | null { return this.capabilities.semanticTokensProvider?.legend ?? null; }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'crashed') return;
    this.state = 'stopped';
    this.scheduler.dispose();
    try {
      await this.rpc.request('shutdown', null, 3_000);
      this.rpc.notify('exit', null);
    } catch { /* force below */ }
    const exited = await new Promise<boolean>((resolve) => {
      if (this.child.exitCode !== null) return resolve(true);
      const timeout = setTimeout(() => resolve(false), 3_000);
      timeout.unref?.();
      this.child.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    if (!exited) {
      try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    this.rpc.dispose('lsp server stopped');
  }
}
