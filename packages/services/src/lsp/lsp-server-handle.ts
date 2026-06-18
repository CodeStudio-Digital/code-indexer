/**
 * One running LSP server instance: spawn → initialize handshake → document
 * sync forwarding → position requests → shutdown. State machine:
 * `starting → ready → stopped|crashed`. The manager owns restart policy;
 * the handle only reports its exit.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LspRpcClient } from './lsp-client.js';
import {
  pathToUri,
  uriToPath,
  toLsp,
  type LspDiagnostic,
  type ServerCapabilities,
} from './lsp-protocol.js';

export type LspHandleState = 'starting' | 'ready' | 'stopped' | 'crashed';

export interface LspSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  rootPath: string;
  initializationOptions?: unknown;
  /** Config dinâmica per-projeto para `workspace/configuration` (language level). */
  resolveConfig?: (section: string | null) => unknown;
}

const INIT_TIMEOUT_MS = 30_000;
const REQ_TIMEOUT_MS = { completion: 5_000, hover: 5_000, definition: 10_000, references: 30_000, resolve: 5_000 } as const;
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
  private readyPromise: Promise<void>;

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
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    delete env.NODE_OPTIONS;
    this.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false, // absolute command path — never .cmd shims here
    });
    this.rpc = new LspRpcClient(this.child, hooks.log, spec.resolveConfig);

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
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      initializationOptions: this.spec.initializationOptions,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
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
          definition: {}, references: {}, documentSymbol: {}, signatureHelp: {},
        },
      },
    }, INIT_TIMEOUT_MS);
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

  completion(
    absPath: string,
    position: { line: number; column: number },
    context?: { triggerKind: number; triggerCharacter?: string },
  ): Promise<unknown> {
    return this.rpc.request('textDocument/completion', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
      // LSP CompletionTriggerKind: 1=Invoked, 2=TriggerCharacter,
      // 3=TriggerForIncompleteCompletions. Intelephense ranks/filters by it.
      ...(context ? { context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter } } : {}),
    }, REQ_TIMEOUT_MS.completion);
  }

  /**
   * `completionItem/resolve` — servers defer expensive fields here;
   * crucially `additionalTextEdits` (the auto-import use/import statement)
   * is usually ONLY present after resolve. Echo the full original item.
   */
  resolveCompletion(item: unknown): Promise<unknown> {
    return this.rpc.request('completionItem/resolve', item, REQ_TIMEOUT_MS.resolve);
  }

  hover(absPath: string, position: { line: number; column: number }): Promise<unknown> {
    return this.rpc.request('textDocument/hover', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
    }, REQ_TIMEOUT_MS.hover);
  }

  definition(absPath: string, position: { line: number; column: number }): Promise<unknown> {
    return this.rpc.request('textDocument/definition', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
    }, REQ_TIMEOUT_MS.definition);
  }

  references(absPath: string, position: { line: number; column: number }): Promise<unknown> {
    return this.rpc.request('textDocument/references', {
      textDocument: { uri: pathToUri(absPath) },
      position: toLsp(position),
      context: { includeDeclaration: true },
    }, REQ_TIMEOUT_MS.references);
  }

  /** Graceful: shutdown request → exit notification → SIGKILL after 3s. */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'crashed') return;
    this.state = 'stopped';
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
