/**
 * Minimal LSP types + the two conversion seams the whole integration
 * hinges on:
 *
 *  - POSITIONS: this app's contract is 1-based (line, column) in UTF-16
 *    code units; LSP is 0-based UTF-16 by default. We negotiate
 *    `positionEncodings: ['utf-16']` at initialize, so converting is ±1 —
 *    no surrogate-pair math anywhere.
 *  - URIs (Windows): emit `file:///d:/x/y.ts` (lowercase drive, forward
 *    slashes); accept both `file:///d:/…` and `file:///d%3A/…` back.
 */

export interface LspPosition0 { line: number; character: number }
export interface LspRange0 { start: LspPosition0; end: LspPosition0 }

export interface LspDiagnostic {
  range: LspRange0;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  /** Plain TextEdit OR InsertReplaceEdit (when client declares insertReplaceSupport). */
  textEdit?: { newText: string; range?: LspRange0; insert?: LspRange0; replace?: LspRange0 };
  /** Auto-import use/import statements (often only filled by `completionItem/resolve`). */
  additionalTextEdits?: Array<{ range: LspRange0; newText: string }>;
  /** Opaque server token the resolve round-trip must echo back. */
  data?: unknown;
  // ── Fidelity fields ──
  sortText?: string;
  filterText?: string;
  insertTextFormat?: 1 | 2;
  preselect?: boolean;
  labelDetails?: { detail?: string; description?: string };
  commitCharacters?: string[];
  deprecated?: boolean;
  tags?: number[];
}

export interface LspTextEdit {
  range: LspRange0;
  newText: string;
}

export interface LspFoldingRange {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  kind?: string;
  collapsedText?: string;
}

export interface LspInlayHintLabelPart {
  value: string;
  tooltip?: string | { kind?: string; value: string };
  location?: { uri: string; range: LspRange0 };
  command?: { title: string; command: string; arguments?: unknown[] };
}

export interface LspInlayHint {
  position: LspPosition0;
  label: string | LspInlayHintLabelPart[];
  kind?: 1 | 2;
  textEdits?: LspTextEdit[];
  tooltip?: string | { kind?: string; value: string };
  paddingLeft?: boolean;
  paddingRight?: boolean;
  data?: unknown;
}

export interface LspLinkedEditingRanges {
  ranges: LspRange0[];
  wordPattern?: string;
}

export interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<LspTextDocumentEdit | Record<string, unknown>>;
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: LspWorkspaceEdit;
  command?: { title?: string; command: string; arguments?: unknown[] };
  /** Opaque token used by codeAction/resolve. */
  data?: unknown;
  disabled?: { reason: string };
}

export interface LspLocationLike {
  uri?: string;
  targetUri?: string;
  range?: LspRange0;
  targetSelectionRange?: LspRange0;
}

export interface LspHover {
  contents:
    | string
    | { kind?: string; value: string }
    | Array<string | { language?: string; value: string }>;
}

/** `textDocument/signatureHelp` answer. Parameter label may be a plain
 *  string OR a [start,end] offset pair into the signature label. */
export interface LspSignatureHelp {
  signatures?: Array<{
    label: string;
    documentation?: string | { value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: string | { value: string };
    }>;
  }>;
  activeSignature?: number | null;
  activeParameter?: number | null;
}

/** Hierarchical shape of `textDocument/documentSymbol` (has `range`). */
export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind?: number;
  range?: LspRange0;
  selectionRange?: LspRange0;
  children?: LspDocumentSymbol[];
}

/** Flat legacy shape of `textDocument/documentSymbol` (has `location`). */
export interface LspSymbolInformation {
  name: string;
  kind?: number;
  location?: { uri?: string; range?: LspRange0 };
  containerName?: string;
}

export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface ServerCapabilities {
  textDocumentSync?: number | { change?: number };
  positionEncoding?: string;
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
  typeDefinitionProvider?: boolean | Record<string, unknown>;
  foldingRangeProvider?: boolean | Record<string, unknown>;
  inlayHintProvider?: boolean | { resolveProvider?: boolean };
  linkedEditingRangeProvider?: boolean | Record<string, unknown>;
  executeCommandProvider?: { commands?: string[] };
  semanticTokensProvider?: {
    legend: SemanticTokensLegend;
    full?: boolean | { delta?: boolean };
    range?: boolean;
  };
}

// ─── position conversions (±1 only — see header) ───────────────────

export const toLsp = (p: { line: number; column: number }): LspPosition0 => ({
  line: Math.max(0, p.line - 1),
  character: Math.max(0, p.column - 1),
});

export const fromLsp = (p: LspPosition0): { line: number; column: number } => ({
  line: p.line + 1,
  column: p.character + 1,
});

// ─── URI ↔ path (win32-safe) ───────────────────────────────────────

export function pathToUri(absPath: string): string {
  let p = absPath.replace(/\\/g, '/');
  // Lowercase the drive letter — matches tsCanonical and keeps one identity
  // per file across the app.
  p = p.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  if (!p.startsWith('/')) p = `/${p}`;
  // Encode only what URIs require; keep `/` and `:` readable.
  return `file://${p.split('/').map((seg) => (seg.includes(':') ? seg : encodeURIComponent(seg))).join('/')}`;
}

export function uriToPath(uri: string): string {
  let rest = uri.replace(/^file:\/\//i, '');
  // Hostless URIs start with /; UNC (`file://server/share`) keeps the host.
  if (rest.startsWith('/')) rest = rest.slice(1);
  else rest = `//${rest}`; // UNC
  let decoded: string;
  try { decoded = decodeURIComponent(rest); } catch { decoded = rest; }
  // `d%3A` → `d:` already handled by decode; normalize drive case + slashes.
  decoded = decoded.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  return decoded.replace(/\\/g, '/');
}

export function mapSeverity(sev?: 1 | 2 | 3 | 4): 'error' | 'warning' | 'info' | 'hint' {
  switch (sev) {
    case 1: return 'error';
    case 2: return 'warning';
    case 3: return 'info';
    case 4: return 'hint';
    default: return 'warning';
  }
}

/** LSP CompletionItemKind (numeric) → this app's string kinds. */
export function mapCompletionKind(kind?: number): string {
  switch (kind) {
    case 2: return 'method';
    case 3: return 'function';
    case 4: return 'constructor';
    case 5: return 'property';
    case 6: return 'variable';
    case 7: return 'class';
    case 8: return 'interface';
    case 9: return 'module';
    case 10: return 'property';
    case 13: return 'enum';
    case 14: return 'keyword';
    case 20: return 'enum member';
    case 21: return 'constant';
    case 22: return 'class';      // struct
    case 25: return 'type parameter';
    default: return 'text';
  }
}

export function hoverToMarkdown(hover: LspHover | null | undefined): string | null {
  if (!hover) return null;
  const c = hover.contents;
  const one = (x: string | { language?: string; value: string; kind?: string }): string =>
    typeof x === 'string' ? x : x.language ? '```' + x.language + '\n' + x.value + '\n```' : x.value;
  const text = Array.isArray(c) ? c.map(one).filter(Boolean).join('\n\n') : one(c);
  return text.trim() ? text : null;
}
