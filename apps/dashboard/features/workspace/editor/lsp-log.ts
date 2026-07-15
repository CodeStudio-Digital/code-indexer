/**
 * Logger estruturado dev-gated da superfície LSP do cliente. No-op em produção
 * a menos que localStorage['mcp-ide:lsp-debug'] === '1' (o usuário liga do console
 * e captura um repro sem rebuild). Mantém um ring-buffer dos últimos 50 eventos em
 * window.__lspLog para o LSP Doctor / tooltip ler sem round-trip ao backend.
 *
 * Fase 0 do overhaul do editor — apenas observabilidade, sem mudança de comportamento.
 * Os call-sites (lspProvider/inlineCompletionProvider) sempre preservam o contrato de
 * retorno ao Monaco; este logger só registra ao lado do return.
 */

export type LspOp =
  | 'completion' | 'resolve' | 'hover' | 'definition'
  | 'references' | 'inline' | 'semanticTokens' | 'codeActions' | 'rename'
  | 'signatureHelp' | 'documentSymbols'
  | 'formatting' | 'organizeImports' | 'implementation';

export type LspOutcome = 'ok' | 'threw' | 'empty' | 'timeout' | 'no-provider';

export interface LspEvent {
  op: LspOp;
  file: string;
  lang: string;
  outcome: LspOutcome;
  /** sugestões retornadas (completion/inline) */
  count?: number;
  /** latência observada no cliente (ms) */
  ms?: number;
  /** mensagem do erro — nunca a stack para o Monaco */
  err?: string;
  /** fonte da resposta quando conhecida (preenchido por logs do backend espelhados) */
  source?: 'server' | 'index' | 'soft-timeout';
}

const RING_MAX = 50;
const STORAGE_FLAG = 'mcp-ide:lsp-debug';

interface WindowWithLog {
  __lspLog?: LspEvent[];
  __lspCounters?: Record<LspCounter, number>;
}

export type LspCounter = 'rangeCorrected' | 'resync' | 'staleSessionIgnored' | 'lruEviction';

export function incrementLspCounter(counter: LspCounter): void {
  const w = window as unknown as WindowWithLog;
  w.__lspCounters ??= { rangeCorrected: 0, resync: 0, staleSessionIgnored: 0, lruEviction: 0 };
  w.__lspCounters[counter] += 1;
}

function ring(): LspEvent[] {
  const w = window as unknown as WindowWithLog;
  if (!w.__lspLog) w.__lspLog = [];
  return w.__lspLog;
}

export function lspDebugEnabled(): boolean {
  try {
    const dev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
    if (dev) return true;
    return window.localStorage.getItem(STORAGE_FLAG) === '1';
  } catch {
    return false;
  }
}

export function logLsp(e: LspEvent): void {
  if (!lspDebugEnabled()) return;
  const buf = ring();
  buf.push(e);
  if (buf.length > RING_MAX) buf.splice(0, buf.length - RING_MAX);
  // console.debug não polui a UI e é fácil de filtrar por "[lsp]".
  // eslint-disable-next-line no-console
  console.debug(
    '[lsp]',
    e.op,
    e.outcome,
    e.lang,
    e.file,
    e.count ?? '',
    e.ms != null ? `${Math.round(e.ms)}ms` : '',
    e.source ?? '',
    e.err ?? '',
  );
}

/** Última fonte registrada para um arquivo (o tooltip do LanguageChip lê isto em dev). */
export function lastCompletionSource(file: string): LspEvent['source'] | undefined {
  const buf = ring();
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].op === 'completion' && buf[i].file === file) return buf[i].source;
  }
  return undefined;
}
