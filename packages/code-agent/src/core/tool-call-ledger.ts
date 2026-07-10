/** Shared, behavior-neutral accounting for direct and nested tool calls. */
import { stableArgsKey } from './runner/dup-utils.js';

export interface ToolCallLedgerEntry {
  seq: number;
  name: string;
  logicalOperationId: string;
  productive: boolean;
  isError: boolean;
  refusalKind?: string;
  resultFingerprint: string;
  outcome: 'success' | 'tool_error' | 'refusal' | 'timeout' | 'cancelled';
  durationMs: number;
  executionClass?: string;
  repeatPolicy?: string;
  readCoverage?: { path: string; start: number | null; end: number | null };
  resultNovel: boolean;
  coverageNovel: boolean;
}

const CONTINUATION_KEYS = new Set([
  'offset', 'limit', 'cursor', 'page', 'page_size', 'after', 'before',
  'start_line', 'end_line', 'line_start', 'line_end', 'start', 'end',
]);

function fnv1a(value: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function logicalArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(logicalArgs);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CONTINUATION_KEYS.has(key.toLowerCase())) continue;
    out[key] = logicalArgs(child);
  }
  return out;
}

export function logicalOperationId(name: string, args: unknown): string {
  return `${name}:${fnv1a(stableArgsKey(logicalArgs(args)))}`;
}

export class ToolCallLedger {
  private seq = 0;
  private readonly resultsByOperation = new Map<string, Set<string>>();
  private readonly coverage = new Set<string>();
  private unsafeLane: Promise<void> = Promise.resolve();

  /**
   * Shared FIFO lane for mutations and other non-parallel-safe operations.
   * The caller hands the returned release callback to the RAW invocation,
   * so a timeout cannot unlock the lane while a non-cancellable write runs.
   */
  async reserveUnsafe(): Promise<() => void> {
    const prior = this.unsafeLane;
    let release!: () => void;
    const reservation = new Promise<void>((resolve) => { release = resolve; });
    this.unsafeLane = prior.then(() => reservation, () => reservation);
    await prior;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  record(input: {
    name: string;
    args: unknown;
    content: string;
    isError: boolean;
    refusalKind?: string;
    mutates?: boolean;
    durationMs?: number;
    executionClass?: string;
    repeatPolicy?: string;
  }): ToolCallLedgerEntry {
    const operation = logicalOperationId(input.name, input.args);
    const fingerprint = fnv1a(input.content);
    const seen = this.resultsByOperation.get(operation) ?? new Set<string>();
    const novel = !seen.has(fingerprint);
    seen.add(fingerprint);
    this.resultsByOperation.set(operation, seen);
    const argRecord = input.args && typeof input.args === 'object'
      ? input.args as Record<string, unknown>
      : {};
    const path = typeof argRecord.path === 'string'
      ? argRecord.path
      : typeof argRecord.file_path === 'string' ? argRecord.file_path : null;
    const toLine = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
    const readCoverage = path && /(?:^|__)(?:read_file|get_symbol_body|get_file_skeleton)$/.test(input.name)
      ? {
          path,
          start: toLine(argRecord.start_line ?? argRecord.line_start ?? argRecord.offset),
          end: toLine(argRecord.end_line ?? argRecord.line_end),
        }
      : undefined;
    const coverageKey = readCoverage
      ? `${input.name}|${readCoverage.path}|${readCoverage.start ?? '*'}|${readCoverage.end ?? '*'}`
      : null;
    const coverageNovel = coverageKey != null && !this.coverage.has(coverageKey);
    if (coverageKey) this.coverage.add(coverageKey);
    const outcome = input.refusalKind === 'timeout'
      ? 'timeout'
      : input.refusalKind === 'abort' || input.refusalKind === 'cancelled'
        ? 'cancelled'
        : input.refusalKind
          ? 'refusal'
          : input.isError ? 'tool_error' : 'success';
    return {
      seq: ++this.seq,
      name: input.name,
      logicalOperationId: operation,
      productive: outcome === 'success' && (!!input.mutates || novel || coverageNovel),
      isError: input.isError,
      ...(input.refusalKind ? { refusalKind: input.refusalKind } : {}),
      resultFingerprint: fingerprint,
      outcome,
      durationMs: Math.max(0, input.durationMs ?? 0),
      ...(input.executionClass ? { executionClass: input.executionClass } : {}),
      ...(input.repeatPolicy ? { repeatPolicy: input.repeatPolicy } : {}),
      ...(readCoverage ? { readCoverage } : {}),
      resultNovel: novel,
      coverageNovel,
    };
  }
}
