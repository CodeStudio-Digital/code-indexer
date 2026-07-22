import type { ApiContext, AsyncStream } from './common.js';

/**
 * LSP-style operations backed by the TypeScript Compiler API in-process.
 * Source: packages/code-agent/src/lsp/ts-service.ts. Delegates to the
 * lsp-worker (kind='lsp' in the worker pool) when the IDE editor calls
 * one of these on every keystroke (debounced).
 *
 * MVP: only .ts / .tsx / .js / .jsx are fully supported. Other languages
 * get Monaco built-in syntax highlight but no completion/hover/etc.
 *
 * Routes mapped: NEW — apps/http-api/server/routes/lsp/lsp.routes.ts
 * (created in Dia 10).
 */

export interface Position {
  /** 1-based, matching ts-service.ts contract. */
  line: number;
  column: number;
}

export interface LspLocation {
  file: string;
  range: { start: Position; end: Position };
}

export interface TextEditDTO {
  range: { start: Position; end: Position };
  newText: string;
}

export interface WorkspaceEditDTO {
  /** Absolute file paths for backend/provider edits; ranges remain 1-based. */
  changes: Record<string, TextEditDTO[]>;
}

export interface CodeActionDTO {
  title: string;
  kind: string;
  isPreferred?: boolean;
  edit?: WorkspaceEditDTO;
  command?: { command: string; arguments?: unknown[] };
  /** Exact server that produced the opaque action; resolve/execute are pinned to it. */
  originServerId?: string;
  /** Opaque route that produced the action (needed for multi-workspace servers). */
  originRouteId?: string;
  raw?: unknown;
  needsResolve?: boolean;
}

/**
 * Signature help (parameter hints) — Ctrl+P / typing `(`/`,`. Produced by
 * the TS service, external LSP servers, or the index fallback; the shape is
 * Monaco's SignatureHelp minus the Monaco-only fields.
 */
export interface SignatureHelpDTO {
  signatures: Array<{
    label: string;
    parameters: Array<{ label: string; documentation?: string }>;
    documentation?: string;
  }>;
  activeSignature: number;
  activeParameter: number;
}

/**
 * One outline node (document symbol) — 1-based ranges like every DTO here.
 * `kind` is a lowercase string ('class' | 'method' | …); the renderer maps
 * it onto Monaco's numeric SymbolKind. `range` spans the full body,
 * `selectionRange` just the name (breadcrumbs/sticky-scroll contract).
 */
export interface DocumentSymbolDTO {
  name: string;
  detail?: string;
  kind: string;
  range: { start: Position; end: Position };
  selectionRange: { start: Position; end: Position };
  children?: DocumentSymbolDTO[];
}

/** One document folding region. Lines are 1-based, like every public LSP DTO. */
export interface FoldingRangeDTO {
  startLine: number;
  endLine: number;
  /** Standard values are `comment`, `imports`, and `region`; custom LSP kinds survive. */
  kind?: string;
}

export interface InlayHintLabelPartDTO {
  label: string;
  tooltip?: string;
  location?: LspLocation;
  command?: { title: string; command: string; arguments?: unknown[] };
}

/** LSP 3.17 inlay hint with 1-based positions/ranges and Monaco-safe fields. */
export interface InlayHintDTO {
  position: Position;
  label: string | InlayHintLabelPartDTO[];
  /** LSP InlayHintKind: 1 = type, 2 = parameter. */
  kind?: 1 | 2;
  tooltip?: string;
  textEdits?: TextEditDTO[];
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

/** Ranges whose contents are edited together. All ranges are 1-based. */
export interface LinkedEditingRangesDTO {
  ranges: Array<{ start: Position; end: Position }>;
  /** LSP regex source (no delimiters); the renderer compiles it defensively. */
  wordPattern?: string;
}

export interface CompletionItem {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
  /**
   * Auto-import edits (the `use`/`import` statement), 1-based ranges.
   * Present immediately when the server eager-fills them; otherwise the
   * client lazily fetches them via `resolveCompletion` using `raw`.
   */
  additionalTextEdits?: Array<{ range: { start: Position; end: Position }; newText: string }>;
  /** Opaque original LSP item — echo back in resolveCompletion. */
  raw?: unknown;
  // ── PHPStorm-grade fidelity (all optional; each producer fills what it
  //    has — TS service, external LSP server, or the index fallback). ──
  /** Server relevance order — Monaco MUST honor this or it re-sorts A→Z. */
  sortText?: string;
  /** String Monaco filters against (CamelCase etc.); defaults to label. */
  filterText?: string;
  /** 1 = plain text, 2 = snippet (`${1:..}` placeholders / paren insertion). */
  insertTextFormat?: 1 | 2;
  /** Mark the best match pre-selected in the widget. */
  preselect?: boolean;
  /** Secondary label columns (type/namespace), PHPStorm-style. */
  labelDetails?: { detail?: string; description?: string };
  /** Characters that auto-accept the item (`.`, `(`, …). */
  commitCharacters?: string[];
  /** Server-chosen replace range (1-based) — authoritative for `::`/`->`. */
  textEdit?: { range: { start: Position; end: Position }; newText: string };
  /** Insert/replace fidelity for servers that distinguish typed span vs replacement span. */
  insertReplaceEdit?: {
    insert: { start: Position; end: Position };
    replace: { start: Position; end: Position };
    newText: string;
  };
  /** Deprecated marker/tags from the producing server. */
  deprecated?: boolean;
  tags?: number[];
  /** Shown in the completion details and useful for deterministic diagnostics. */
  origin?: 'ts' | 'lsp' | 'index';
}

export interface LspCompletionList {
  items: CompletionItem[];
  isIncomplete: boolean;
}

export interface HoverInfo {
  contents: string;
  range?: { start: Position; end: Position };
}

export interface DiagnosticItem {
  file: string;
  range: { start: Position; end: Position };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

// ─── Stateful document sync (IDE-grade, replaces content-per-call) ──

/**
 * One Monaco content change. `range` is 1-based (this contract);
 * `rangeOffset`/`rangeLength` are absolute offsets into the PRE-change
 * buffer — the backend applies deltas by offset, no line math.
 */
export interface DocChange {
  range: { start: Position; end: Position };
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/** Per-file diagnostics push frame. `diagnostics: []` clears the file. */
export interface DiagnosticsFrame {
  /** Project-relative forward-slash path (the editor's model key). */
  file: string;
  /**
   * Producer identity — also the Monaco marker owner (`mcp-lsp:${source}`), so
   * each producer owns a disjoint marker set. `lint:${tool}` is the external
   * linter adapter (stylelint/eslint/shellcheck/…); it never clears `syntax`
   * (a linter augments, it doesn't supersede tree-sitter highlighting).
   */
  source: 'ts' | `lsp:${string}` | `lint:${string}` | 'index' | 'syntax';
  diagnostics: DiagnosticItem[];
}

/**
 * Wire unit of `diagnosticsStream` — one message carries MANY per-file
 * frames. External LSP servers can publish diagnostics for thousands of
 * files back-to-back (e.g. OmniSharp after a solution load); batching keeps
 * that a handful of IPC messages instead of one per file.
 */
export interface DiagnosticsBatch {
  frames: DiagnosticsFrame[];
}

// ─── External LSP servers (tier 1: PHP / Python / JSON-CSS-HTML) ───

export type LspServerState =
  | 'no-server'
  | 'not-installed'
  | 'idle'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'disabled'
  | 'needs-profile'
  | 'unsupported';

export interface LspServerRouteInfo {
  routeId?: string;
  familyId?: string;
  workspaceId: string;
  /** Project-relative display path; absolute host paths never cross the API. */
  workspacePath: string;
  profileId?: string;
  projectVersion?: string;
  projectMajor?: number;
  versionSource?: 'installed' | 'package-lock' | 'pnpm-lock' | 'yarn-lock' | 'package-json' | 'override' | 'unknown';
  confidence?: 'high' | 'medium' | 'none';
  supportTier?: 'full' | 'best-effort' | 'unsupported';
}

export interface AngularProfileOverrideInfo {
  workspacePath: string;
  profileId: string;
}

export interface LspServerStatus {
  state: LspServerState;
  server?: {
    id: string;
    familyId?: string;
    profileId?: string;
    label: string;
    version: string;
    sizeLabel: string;
    supportTier?: 'full' | 'best-effort' | 'unsupported';
  };
  route?: LspServerRouteInfo;
  /** MCP_LSP_AUTO_PROMPT — whether the editor should offer the install banner. */
  autoPrompt?: boolean;
  /** Short human-readable cause when state==='failed' (stderr tail / timeout). */
  reason?: string;
  /** External runtime required by the server and its current resolution. */
  runtime?: {
    kind: 'java' | 'dotnet';
    minMajor: number;
    satisfied: boolean;
    version?: string;
    reason?: string;
  };
  nodeRuntime?: {
    range: string;
    satisfied: boolean;
    source?: 'project' | 'app';
    version?: string;
    reason?: string;
  };
  workspaceMode?: 'project' | 'generated-unity' | 'generated-basic' | 'loose';
  workspaceReason?: string;
}

/**
 * Live server-status transition for one language, pushed over
 * `serverStatusStream`. The chip hook filters a project's stream by its
 * own languageId.
 */
export interface LspServerStatusFrame {
  languageId: string;
  state: LspServerState;
  server?: LspServerStatus['server'];
  route?: LspServerRouteInfo;
  reason?: string;
}

export interface LspServerInfo {
  id: string;
  familyId?: string;
  profileId?: string;
  label: string;
  languages: string[];
  version: string;
  installed: boolean;
  sizeLabel: string;
  supportTier?: 'full' | 'best-effort' | 'unsupported';
}

export type LspInstallFrame =
  | { phase: 'start'; serverId: string; version: string; targetDir: string }
  | { phase: 'log'; line: string }
  | { phase: 'done'; installDir: string }
  | { phase: 'error'; message: string };

/**
 * All position-based LSP calls accept an optional `content` carrying the
 * EDITOR'S live model text. When present, the backend snapshots it into
 * the TS Compiler API's host BEFORE computing — without this, completion
 * / hover / diagnostics read the on-disk version and miss whatever the
 * user just typed (the canonical bug: typing `this.router.` produced no
 * suggestions because the dot wasn't saved yet). The renderer should
 * pass `model.getValue()` for the file it's querying. Other files'
 * snapshots stay disk-backed and only refresh when their tab is active
 * and queried.
 */
export interface LspApi {
  /**
   * Open/refresh a document buffer on the backend. From here on the
   * position-based calls need only `{file, position}` — the backend serves
   * the live buffer to the TS service / LSP servers / index fallback.
   */
  didOpen(
    input: { projectId: number; file: string; languageId: string; version: number; content: string; syncSessionId: string },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  /**
   * Incremental deltas (Monaco's onDidChangeContent shape). `{resync: true}`
   * means the backend lost track of versions — re-send a full didOpen.
   */
  didChange(
    input: { projectId: number; file: string; version: number; changes: DocChange[]; syncSessionId: string },
    ctx: ApiContext,
  ): Promise<{ ok: true } | { resync: true }>;

  didClose(
    input: { projectId: number; file: string; syncSessionId: string },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  /**
   * Push diagnostics — batches of (file, source) frames, coalesced per
   * file. Replaces the renderer's 1s polling loop. The `Stream` suffix is
   * load-bearing (auto MessagePort on Electron; SSE route on Hono).
   */
  diagnosticsStream(
    input: { projectId: number },
    ctx: ApiContext,
  ): AsyncStream<DiagnosticsBatch>;

  completion(
    input: {
      projectId: number; file: string; position: Position; content?: string;
      /** Monaco CompletionContext — drives the server's trigger-aware ranking. */
      context?: { triggerKind: number; triggerCharacter?: string };
    },
    ctx: ApiContext,
  ): Promise<LspCompletionList>;

  /**
   * Lazy `completionItem/resolve` — servers (Intelephense/Pyright) only
   * attach `additionalTextEdits` (the auto-import statement) here. `item`
   * is the opaque `raw` from a completion() result. Null = nothing extra
   * (TS service / index fallback items resolve client-side as-is).
   */
  resolveCompletion(
    input: { projectId: number; file: string; item: unknown },
    ctx: ApiContext,
  ): Promise<CompletionItem | null>;

  hover(
    input: { projectId: number; file: string; position: Position; content?: string },
    ctx: ApiContext,
  ): Promise<HoverInfo | null>;

  definition(
    input: { projectId: number; file: string; position: Position; content?: string },
    ctx: ApiContext,
  ): Promise<LspLocation[]>;

  /** Go to the definition of the symbol's type. */
  typeDefinition(
    input: { projectId: number; file: string; position: Position },
    ctx: ApiContext,
  ): Promise<LspLocation[]>;

  /** Document folding regions (1-based lines). */
  foldingRanges(
    input: { projectId: number; file: string },
    ctx: ApiContext,
  ): Promise<FoldingRangeDTO[]>;

  /** Inlay hints intersecting the requested 1-based visible range. */
  inlayHints(
    input: { projectId: number; file: string; range: { start: Position; end: Position } },
    ctx: ApiContext,
  ): Promise<InlayHintDTO[]>;

  /** Ranges linked to the symbol at the requested 1-based position. */
  linkedEditingRanges(
    input: { projectId: number; file: string; position: Position },
    ctx: ApiContext,
  ): Promise<LinkedEditingRangesDTO | null>;

  references(
    input: { projectId: number; file: string; position: Position; content?: string },
    ctx: ApiContext,
  ): Promise<LspLocation[]>;

  diagnostics(
    input: { projectId: number; file?: string; content?: string },
    ctx: ApiContext,
  ): Promise<DiagnosticItem[]>;

  /**
   * Semantic-token classifications for syntax highlighting. The TS
   * Compiler API tags every identifier in the file as class /
   * interface / property / method / parameter / etc. — the renderer
   * maps those to Monaco's semantic-token registry so themes can colour
   * them distinctly (e.g. `this.router` reads as a property, not as
   * a plain identifier).
   *
   * Returned `data` is the LSP-style delta-encoded array Monaco
   * consumes via `registerDocumentSemanticTokensProvider`:
   *   [ deltaLine, deltaStart, length, tokenType, tokenModifiers,
   *     deltaLine, deltaStart, length, tokenType, tokenModifiers, … ]
   *
   * Token type / modifier indices reference the legend the renderer
   * declares on registration — see `lspProvider.ts`.
   */
  semanticTokens(
    input: { projectId: number; file: string; content?: string },
    ctx: ApiContext,
  ): Promise<{ data: number[]; resultId?: string }>;

  /** Is there a (tier-1) server for this language, and is it installed/running? */
  serverStatus(
    input: { projectId: number; languageId: string; file?: string },
    ctx: ApiContext,
  ): Promise<LspServerStatus>;

  /**
   * Live status transitions for ALL languages of a project (one stream per
   * project; the chip filters by its languageId). `Stream` suffix →
   * MessagePort on Electron, SSE route for browser dev. Makes the chip flip
   * green the moment a late-spawning server becomes ready instead of staying
   * stale on the one-shot serverStatus poll.
   */
  serverStatusStream(
    input: { projectId: number },
    ctx: ApiContext,
  ): AsyncIterable<LspServerStatusFrame>;

  /** Catalog + installed flags for the admin panel / editor CTA. */
  listServers(input: void, ctx: ApiContext): Promise<LspServerInfo[]>;

  /** Live server instances (per project) for the admin panel + LSP Doctor. */
  instances(input: void, ctx: ApiContext): Promise<Array<{
    projectId: number;
    serverId: string;
    /** Opaque identity for a workspace/profile-specific server instance. */
    routeId?: string;
    /** Server family shared by its compatibility profiles. */
    familyId?: string;
    /** Compatibility profile selected for this instance. */
    profileId?: string;
    state: string;
    /** Last failure reason (stderr tail / timeout) when the server crashed. */
    lastExitReason?: string;
    /** Tail of the server's stderr ring — surfaced in the Doctor for P2 diagnosis. */
    stderrTail?: string;
    /** Per-server admission-control counters for performance diagnosis. */
    requests?: {
      queued: number;
      inFlight: number;
      backgroundInFlight: number;
      cancelled: number;
      superseded: number;
    };
    inactive?: boolean;
    lruEvictions?: number;
    workspaceMode?: 'project' | 'generated-unity' | 'generated-basic' | 'loose';
    workspaceReason?: string;
    counters?: { resync: number; staleSessionIgnored: number };
  }>>;

  /** Consent-gated npm install with streamed progress (log tail). */
  installServerStream(input: { serverId: string }, ctx: ApiContext): AsyncStream<LspInstallFrame>;

  removeServer(input: { serverId: string }, ctx: ApiContext): Promise<{ ok: boolean }>;

  restartServer(
    input: { projectId: number; serverId: string; routeId?: string; file?: string },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  angularProfileOverrides(
    input: { projectId: number },
    ctx: ApiContext,
  ): Promise<AngularProfileOverrideInfo[]>;

  setAngularProfileOverride(
    input: { projectId: number; workspacePath: string; profileId: string | null },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  /**
   * Define a versão da linguagem (language level) do projeto e reinicia o server
   * que a serve (intelephense/pyright) para reler a config. Entregue ao server via
   * `workspace/configuration` + `initializationOptions`.
   */
  setLanguageLevel(
    input: { projectId: number; languageId: 'php' | 'python'; level: string },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  /**
   * Versão EFETIVA por linguagem para o chip: escolha explícita, senão auto-detect do
   * manifesto (composer.json/pyproject.toml), senão o default. `source` distingue a origem.
   */
  languageLevels(
    input: { projectId: number },
    ctx: ApiContext,
  ): Promise<Record<'php' | 'python', { level: string; source: 'explicit' | 'detected' | 'default' }>>;

  rename(
    input: { projectId: number; file: string; position: Position; newName: string },
    ctx: ApiContext,
  ): Promise<{ edits: Array<{ file: string; range: { start: Position; end: Position }; newText: string }> }>;

  /**
   * Parameter hints at a call site. Routed like the other position ops
   * (ts/js → TS service; server languages → textDocument/signatureHelp;
   * index fallback otherwise). Null = nothing to show.
   */
  signatureHelp(
    input: { projectId: number; file: string; position: Position },
    ctx: ApiContext,
  ): Promise<SignatureHelpDTO | null>;

  /**
   * Outline tree for a file (breadcrumbs / sticky scroll / Ctrl+F12).
   * Hierarchical when the backend supports it; empty array = no symbols.
   */
  documentSymbols(
    input: { projectId: number; file: string },
    ctx: ApiContext,
  ): Promise<DocumentSymbolDTO[]>;

  codeActions(
    input: {
      projectId: number;
      file: string;
      range: { start: Position; end: Position };
      /** Monaco trigger origin: automatic lightbulb work is lower priority. */
      trigger?: 'auto' | 'invoke';
    },
    ctx: ApiContext,
  ): Promise<CodeActionDTO[]>;

  resolveCodeAction(
    input: { projectId: number; file: string; action: CodeActionDTO },
    ctx: ApiContext,
  ): Promise<CodeActionDTO | null>;

  executeCodeAction(
    input: { projectId: number; action: CodeActionDTO },
    ctx: ApiContext,
  ): Promise<{ ok: true; edit?: WorkspaceEditDTO }>;

  /**
   * Document (or range) formatting via the language server owning the file's
   * language (PHP today). TS/JS/JSON/CSS/HTML are NOT routed here — Monaco's
   * built-in workers already format those client-side. 1-based ranges.
   */
  formatting(
    input: {
      projectId: number;
      file: string;
      range?: { start: Position; end: Position };
      options: { tabSize: number; insertSpaces: boolean };
    },
    ctx: ApiContext,
  ): Promise<TextEditDTO[]>;

  /**
   * Organize imports (Ctrl+Alt+O): ts/js → TS service organizeImports;
   * server languages → codeAction `source.organizeImports`. Same edits shape
   * as rename. `applied: false` + `reason` = the language backend exists but
   * doesn't support the action (e.g. Intelephense free) — show a toast.
   */
  organizeImports(
    input: { projectId: number; file: string },
    ctx: ApiContext,
  ): Promise<{
    edits: Array<{ file: string; range: { start: Position; end: Position }; newText: string }>;
    applied?: false;
    reason?: string;
  }>;

  /**
   * Go to implementation (Ctrl+Alt+B): ts/js → getImplementationAtPosition;
   * server languages → textDocument/implementation; otherwise (or empty) →
   * structural-index fallback (implementors + subclasses by name).
   */
  implementation(
    input: { projectId: number; file: string; position: Position },
    ctx: ApiContext,
  ): Promise<LspLocation[]>;
}
