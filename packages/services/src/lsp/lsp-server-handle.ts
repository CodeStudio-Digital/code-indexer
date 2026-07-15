/**
 * One running LSP server instance: spawn → initialize handshake → document
 * sync forwarding → position requests → shutdown. State machine:
 * `starting → ready → stopped|crashed`. The manager owns restart policy;
 * the handle only reports its exit.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setPriority } from 'node:os';
import { LspRpcClient } from './lsp-client.js';
import { LspRequestScheduler, type LspRequestPriority, type LspRequestSchedulerStats } from './lsp-request-scheduler.js';
import {
  pathToUri,
  uriToPath,
  toLsp,
  type LspDiagnostic,
  type ServerCapabilities,
  type SemanticTokensLegend,
} from './lsp-protocol.js';

export type LspHandleState = 'starting' | 'ready' | 'stopped' | 'crashed';

export interface LspSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Best-effort OS scheduling priority applied immediately after spawn. */
  priority?: number;
  rootPath: string;
  initializationOptions?: unknown;
  workspaceFolders?: boolean;
  /** Heavy project systems (OmniSharp/Unity) may legitimately exceed 30s. */
  initializeTimeoutMs?: number;
  /** Config dinâmica per-projeto para `workspace/configuration` (language level). */
  resolveConfig?: (section: string | null) => unknown;
}

const INIT_TIMEOUT_MS = 30_000;
const REQ_TIMEOUT_MS = {
  completion: 5_000,
  hover: 5_000,
  definition: 10_000,
  references: 30_000,
  resolve: 5_000,
  codeAction: 10_000,
  semanticTokens: 10_000,
  // Rename touches every reference in the workspace — references-grade cost.
  rename: 30_000,
  signatureHelp: 5_000,
  documentSymbol: 10_000,
  // Formatting re-prints the whole document — comfortably under 10s warm.
  formatting: 10_000,
  implementation: 10_000,
} as const;
const STDERR_RING = 8 * 1024;

export class LspServerHandle {
  state: LspHandleState = 'starting';
  capabilities: ServerCapabilities = {};
  /** Tail of stderr for crash forensics. */
  stderrTail = '';
  /** URIs já abertas no server (dedup do didOpen + base do ensureOpen — W3). */
  private opened = new Set<string>();
  private child: ChildProcessWithoutNullStreams;
  private rpc: LspRpcClient;
  private scheduler = new LspRequestScheduler();
  private readyPromise: Promise<void>;
  /** Edits emitted by the server during the active workspace/executeCommand. */
  private commandWorkspaceEdits: unknown[] | null = null;

  constructor(
    private spec: LspSpawnSpec,
    private hooks: {
      onDiagnostics: (absPath: string, diagnostics: LspDiagnostic[]) => void;
      onExit: (code: number | null) => void;
      log: (msg: string) => void;
    },
  ) {
    // Dev-mode loaders leak: under `pnpm dev` the parent carries
    // NODE_OPTIONS=--import tsx — the child node then tries to resolve
    // 'tsx' from the PROJECT cwd and exits 1 before speaking a byte of
    // LSP. Language servers never want our loaders; drop them.
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    delete inherited.NODE_OPTIONS;
    delete inherited.JAVA_TOOL_OPTIONS;
    delete inherited._JAVA_OPTIONS;
    delete inherited.JDK_JAVA_OPTIONS;
    const env: NodeJS.ProcessEnv = { ...inherited, ...spec.env };
    this.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false, // absolute command path — never .cmd shims here
    });
    if (spec.priority !== undefined && this.child.pid !== undefined) {
      try {
        setPriority(this.child.pid, spec.priority);
      } catch (err) {
        hooks.log(`could not lower process priority: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.rpc = new LspRpcClient(this.child, hooks.log, spec.resolveConfig, (edit) => {
      if (!this.commandWorkspaceEdits) return false;
      this.commandWorkspaceEdits.push(edit);
      return true;
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf-8')).slice(-STDERR_RING);
    });
    this.child.on('exit', (code) => {
      const wasStopped = this.state === 'stopped';
      this.state = wasStopped ? 'stopped' : 'crashed';
      this.rpc.dispose(`lsp server exited (code ${code})`);
      if (!wasStopped) hooks.onExit(code);
    });
    this.child.on('error', (err) => {
      hooks.log(`spawn error: ${err.message}`);
      this.state = 'crashed';
      this.rpc.dispose(`lsp server spawn error: ${err.message}`);
      hooks.onExit(null);
    });

    this.rpc.onNotification('textDocument/publishDiagnostics', (params) => {
      const p = params as { uri: string; diagnostics: LspDiagnostic[] };
      if (p?.uri) hooks.onDiagnostics(uriToPath(p.uri), p.diagnostics ?? []);
    });
    this.rpc.onNotification('window/logMessage', (params) => {
      const message = (params as { message?: unknown })?.message;
      if (typeof message === 'string') hooks.log(message);
    });

    this.readyPromise = this.initialize();
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToUri(this.spec.rootPath);
    const result = await this.rpc.request<{ capabilities?: ServerCapabilities }>('initialize', {
      processId: process.pid,
      clientInfo: { name: 'codestudio', version: '0.1' },
      rootUri,
      workspaceFolders: this.spec.workspaceFolders === false ? null : [{ uri: rootUri, name: 'workspace' }],
      initializationOptions: this.spec.initializationOptions,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: {
          applyEdit: true,
          configuration: true,
          workspaceFolders: this.spec.workspaceFolders !== false,
          workspaceEdit: { documentChanges: true },
          didChangeConfiguration: { dynamicRegistration: false },
        },
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false },
          completion: {
            // PHPStorm-grade: snippets (paren/placeholder insertion), trigger
            // context for relevance, rich labels, and deferred resolve fields
            // (Intelephense/Pyright attach the auto-import use/import edit only
            // in completionItem/resolve). Standard VS Code client caps — safe
            // and additive for pyright + vscode-langservers too.
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              insertReplaceSupport: true,
              labelDetailsSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
            },
            completionItemKind: {
              valueSet: [
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
                14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
              ],
            },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  'quickfix',
                  'refactor',
                  'refactor.extract',
                  'refactor.inline',
                  'refactor.rewrite',
                  'source',
                  'source.organizeImports',
                  'source.fixAll',
                ],
              },
            },
            isPreferredSupport: true,
          },
          definition: {}, references: {}, implementation: {},
          // Document + range formatting (PHP via Intelephense; other servers
          // that advertise the capability get it for free).
          formatting: {}, rangeFormatting: {},
          // Hierarchical outline (DocumentSymbol[] with children). Servers
          // ignoring this flag answer flat SymbolInformation[] — the mapper
          // in server-backend-ops accepts both shapes.
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          // No labelOffsetSupport: we still MAP [start,end] offset labels
          // (substring of the signature label) in case a server sends them.
          signatureHelp: { signatureInformation: { parameterInformation: { labelOffsetSupport: false } } },
          // No prepareSupport — the client renames whatever word is at the
          // cursor; the server validates and answers the WorkspaceEdit.
          rename: { dynamicRegistration: false },
          // Semantic highlighting — without declaring this some servers don't
          // advertise `semanticTokensProvider`. The tokenTypes/tokenModifiers
          // are the full LSP standard set we understand; the server replies
          // with ITS own legend (server-backend remaps onto Monaco's legend).
          semanticTokens: {
            dynamicRegistration: false,
            requests: { full: true, range: false },
            tokenTypes: [
              'namespace', 'type', 'class', 'enum', 'interface', 'struct',
              'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
              'event', 'function', 'method', 'macro', 'keyword', 'modifier',
              'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
            ],
            tokenModifiers: [
              'declaration', 'definition', 'readonly', 'static', 'deprecated',
              'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
            ],
            formats: ['relative'],
            overlappingTokenSupport: false,
            multilineTokenSupport: false,
          },
        },
      },
    }, this.spec.initializeTimeoutMs ?? INIT_TIMEOUT_MS);
    this.capabilities = result?.capabilities ?? {};
    this.rpc.notify('initialized', {});
    this.state = 'ready';
  }

  /** Incremental when the server declared it; full-text union otherwise. */
  private get supportsIncremental(): boolean {
    const sync = this.capabilities.textDocumentSync;
    const change = typeof sync === 'number' ? sync : sync?.change;
    return change === 2;
  }

  didOpen(absPath: string, languageId: string, version: number, text: string): void {
    const uri = pathToUri(absPath);
    this.opened.add(uri);
    this.rpc.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
  }

  /**
   * Garante que o buffer está aberto no server ANTES de uma completion/hover/etc. (W3):
   * sem isto, uma completion pode chegar antes do didOpen (replay/race no spawn) e o
   * server responde [] para um doc que "não conhece" — causa-raiz do P2. Idempotente.
   */
  ensureOpen(absPath: string, languageId: string, version: number, text: string): void {
    if (this.opened.has(pathToUri(absPath))) return;
    this.didOpen(absPath, languageId, version, text);
  }

  didChange(
    absPath: string,
    version: number,
    fullText: string,
    changes: Array<{ start: { line: number; column: number }; end: { line: number; column: number }; text: string }>,
  ): void {
    const uri = pathToUri(absPath);
    const contentChanges = this.supportsIncremental
      ? changes.map((c) => ({ range: { start: toLsp(c.start), end: toLsp(c.end) }, text: c.text }))
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

  requestStats(): LspRequestSchedulerStats {
    return this.scheduler.stats();
  }

  private request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number,
    priority: LspRequestPriority,
    key?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.scheduler.schedule({
      priority,
      key,
      signal,
      run: (scheduledSignal) => this.rpc.request<T>(method, params, timeoutMs, scheduledSignal),
    });
  }

  completion(
    absPath: string,
    position: { line: number; column: number },
    context?: { triggerKind: number; triggerCharacter?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('textDocument/completion', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
      // LSP CompletionTriggerKind: 1=Invoked, 2=TriggerCharacter,
      // 3=TriggerForIncompleteCompletions. Intelephense ranks/filters by it.
      ...(context ? { context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter } } : {}),
    }, REQ_TIMEOUT_MS.completion, 'interactive', `completion:${absPath}`, signal);
  }

  /**
   * `completionItem/resolve` — servers defer expensive fields here;
   * crucially `additionalTextEdits` (the auto-import use/import statement)
   * is usually ONLY present after resolve. Echo the full original item.
   */
  resolveCompletion(item: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('completionItem/resolve', item, REQ_TIMEOUT_MS.resolve, 'interactive', undefined, signal);
  }

  hover(absPath: string, position: { line: number; column: number }, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/hover', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
    }, REQ_TIMEOUT_MS.hover, 'background', `hover:${absPath}`, signal);
  }

  definition(absPath: string, position: { line: number; column: number }, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/definition', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
    }, REQ_TIMEOUT_MS.definition, 'manual', undefined, signal);
  }

  references(absPath: string, position: { line: number; column: number }, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/references', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
      context: { includeDeclaration: true },
    }, REQ_TIMEOUT_MS.references, 'manual', undefined, signal);
  }

  /** `textDocument/rename` — the server computes the full WorkspaceEdit. */
  rename(
    absPath: string,
    position: { line: number; column: number },
    newName: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('textDocument/rename', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
      newName,
    }, REQ_TIMEOUT_MS.rename, 'manual', undefined, signal);
  }

  /** `textDocument/signatureHelp` — parameter hints at a call site. */
  signatureHelp(absPath: string, position: { line: number; column: number }, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/signatureHelp', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
    }, REQ_TIMEOUT_MS.signatureHelp, 'interactive', `signature:${absPath}`, signal);
  }

  /** `textDocument/documentSymbol` — DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat). */
  documentSymbol(absPath: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/documentSymbol', {
      textDocument: { uri: pathToUri(absPath) },
    }, REQ_TIMEOUT_MS.documentSymbol, 'background', `symbols:${absPath}`, signal);
  }

  codeActions(
    absPath: string,
    range: { start: { line: number; column: number }; end: { line: number; column: number } },
    /** LSP CodeActionContext.only — restrict to kinds like 'source.organizeImports'. */
    only?: string[],
    options: { origin?: 'auto' | 'invoke'; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const automatic = options.origin === 'auto';
    return this.request('textDocument/codeAction', {
      textDocument: { uri: pathToUri(absPath) },
      range: { start: toLsp(range.start), end: toLsp(range.end) },
      context: { diagnostics: [], ...(only ? { only } : {}) },
    }, REQ_TIMEOUT_MS.codeAction, automatic ? 'background' : 'manual', automatic ? `codeAction:${absPath}` : undefined, options.signal);
  }

  supportsCodeActionResolve(): boolean {
    const provider = this.capabilities.codeActionProvider;
    return typeof provider === 'object' && provider.resolveProvider === true;
  }

  resolveCodeAction(action: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('codeAction/resolve', action, REQ_TIMEOUT_MS.codeAction, 'manual', undefined, signal);
  }

  async executeCommand(
    command: string,
    args?: unknown[],
    signal?: AbortSignal,
  ): Promise<{ result: unknown; workspaceEdits: unknown[] }> {
    const advertised = this.capabilities.executeCommandProvider?.commands ?? [];
    if (advertised.length > 0 && !advertised.includes(command)) {
      return Promise.reject(new Error(`LSP command not advertised: ${command}`));
    }
    // A server→client applyEdit request has no parent request id. Serialize
    // command capture so every edit is associated with exactly one click.
    if (this.commandWorkspaceEdits) {
      throw new Error('another LSP code-action command is already running');
    }
    const workspaceEdits: unknown[] = [];
    this.commandWorkspaceEdits = workspaceEdits;
    try {
      const result = await this.request(
        'workspace/executeCommand',
        { command, arguments: args ?? [] },
        REQ_TIMEOUT_MS.codeAction,
        'manual',
        undefined,
        signal,
      );
      return { result, workspaceEdits };
    } finally {
      this.commandWorkspaceEdits = null;
    }
  }

  /** `textDocument/implementation` — Location[] / LocationLink[] like definition. */
  implementation(absPath: string, position: { line: number; column: number }, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/implementation', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
    }, REQ_TIMEOUT_MS.implementation, 'manual', undefined, signal);
  }

  /** `textDocument/formatting` — whole-document TextEdit[]. */
  formatting(
    absPath: string,
    options: { tabSize: number; insertSpaces: boolean },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('textDocument/formatting', {
      textDocument: { uri: pathToUri(absPath) },
      options,
    }, REQ_TIMEOUT_MS.formatting, 'manual', undefined, signal);
  }

  /** `textDocument/rangeFormatting` — TextEdit[] for a 1-based range (toLsp → 0-based). */
  rangeFormatting(
    absPath: string,
    range: { start: { line: number; column: number }; end: { line: number; column: number } },
    options: { tabSize: number; insertSpaces: boolean },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('textDocument/rangeFormatting', {
      textDocument: { uri: pathToUri(absPath) },
      range: { start: toLsp(range.start), end: toLsp(range.end) },
      options,
    }, REQ_TIMEOUT_MS.formatting, 'manual', undefined, signal);
  }

  /** `textDocument/semanticTokens/full` — tokens encoded against the server's
   *  own legend (see `semanticTokensLegend`). Returns `{ data: number[] }`. */
  semanticTokens(absPath: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('textDocument/semanticTokens/full', {
      textDocument: { uri: pathToUri(absPath) },
    }, REQ_TIMEOUT_MS.semanticTokens, 'background', `semanticTokens:${absPath}`, signal);
  }

  /** The server's semantic-token legend (from the init handshake), or null if
   *  it doesn't provide semantic tokens. Needed to remap onto Monaco's legend. */
  semanticTokensLegend(): SemanticTokensLegend | null {
    return this.capabilities.semanticTokensProvider?.legend ?? null;
  }

  /** Graceful: shutdown request → exit notification → SIGKILL after 3s. */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'crashed') return;
    this.state = 'stopped';
    this.scheduler.dispose();
    try {
      await this.rpc.request('shutdown', null, 3_000);
      this.rpc.notify('exit', null);
    } catch { /* server unresponsive — force it below */ }
    const exited = await new Promise<boolean>((resolve) => {
      if (this.child.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), 3_000);
      t.unref?.();
      this.child.once('exit', () => { clearTimeout(t); resolve(true); });
    });
    if (!exited) {
      try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    this.rpc.dispose('lsp server stopped');
  }
}
