import { syntaxDiagnosticsFor } from '../../lsp/syntax-diagnostics.js';

export type CompletionFilterReason =
  | 'syntax'
  | 'unknown-member'
  | 'prefix-echo'
  | 'suffix-overlap'
  | 'unbalanced';

export interface CompletionValidationInput {
  file: string;
  original: string;
  candidate: string;
  offset: number;
  prefix: string;
  suffix: string;
  knownMembers?: string[];
  memberTriggered?: boolean;
}

interface BalanceState {
  stack: string[];
  quote: '' | '"' | "'" | '`';
  lineComment: boolean;
  blockComment: boolean;
}

function scanBalance(text: string, seed?: BalanceState, rejectUnexpectedCloser = false): BalanceState | null {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const state: BalanceState = seed
    ? { stack: [...seed.stack], quote: seed.quote, lineComment: seed.lineComment, blockComment: seed.blockComment }
    : { stack: [], quote: '', lineComment: false, blockComment: false };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1] ?? '';
    if (state.lineComment) {
      if (c === '\n') state.lineComment = false;
      continue;
    }
    if (state.blockComment) {
      if (c === '*' && next === '/') { state.blockComment = false; i++; }
      continue;
    }
    if (state.quote) {
      if (c === '\\') i++;
      else if (c === state.quote) state.quote = '';
      continue;
    }
    if (c === '/' && next === '/') { state.lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { state.blockComment = true; i++; continue; }
    // Python/shell comments and PHP attributes both start with '#'. Treating
    // an attribute as a comment is fail-open here; Tree-sitter remains the
    // authoritative syntax check below.
    if (c === '#') { state.lineComment = true; continue; }
    if (c === '"' || c === "'" || c === '`') { state.quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') state.stack.push(c);
    else if (pairs[c]) {
      if (state.stack.at(-1) !== pairs[c]) {
        if (rejectUnexpectedCloser) return null;
        // Existing malformed code before the cursor must not poison a future
        // suggestion. Tree-sitter compares before/after diagnostics later.
        continue;
      }
      state.stack.pop();
    }
  }
  return state;
}

function balanceOk(candidate: string, documentPrefix = ''): boolean {
  const seed = scanBalance(documentPrefix);
  if (!seed) return true;
  // Open braces are allowed for multiline continuations. A closer is valid
  // when it matches either an opener in the candidate or one before cursor.
  return scanBalance(candidate, seed, true) !== null;
}

function firstMember(candidate: string): string | null {
  const match = candidate.trimStart().match(/^([A-Za-z_$][\w$]*)\s*(?:\(|\b)/);
  return match?.[1] ?? null;
}

type CompletionValidationResult =
  | { ok: true; candidate?: string; salvaged?: true }
  | { ok: false; reason: CompletionFilterReason };

async function validateOne(input: CompletionValidationInput): Promise<CompletionValidationResult> {
  const { candidate, prefix, suffix } = input;
  const prefixTail = prefix.trimEnd().split('\n').at(-1)?.trim() ?? '';
  if (prefixTail.length >= 4 && candidate.trimStart().startsWith(prefixTail)) return { ok: false, reason: 'prefix-echo' };
  const suffixHead = suffix.trimStart().split('\n')[0]?.trim() ?? '';
  if (suffixHead.length >= 4 && candidate.trimEnd().endsWith(suffixHead)) return { ok: false, reason: 'suffix-overlap' };
  const documentPrefix = input.original.slice(0, input.offset);
  if (!balanceOk(candidate, documentPrefix)) return { ok: false, reason: 'unbalanced' };

  if (input.memberTriggered && input.knownMembers && input.knownMembers.length > 0) {
    const member = firstMember(candidate);
    if (member && !input.knownMembers.includes(member)) return { ok: false, reason: 'unknown-member' };
  }

  try {
    const before = await syntaxDiagnosticsFor(input.file, input.original);
    const next = input.original.slice(0, input.offset) + candidate + input.original.slice(input.offset);
    const after = await syntaxDiagnosticsFor(input.file, next);
    const counts = (items: typeof before) => {
      const out = new Map<string, number>();
      for (const item of items) {
        const key = String(item.code ?? item.message);
        out.set(key, (out.get(key) ?? 0) + 1);
      }
      return out;
    };
    const beforeCounts = counts(before);
    const afterCounts = counts(after);
    if (after.length > before.length || [...afterCounts].some(([code, n]) => n > (beforeCounts.get(code) ?? 0))) {
      return { ok: false, reason: 'syntax' };
    }
  } catch { /* unsupported grammar/parser trouble is fail-open */ }
  return { ok: true };
}

function salvagePrefixes(candidate: string): string[] {
  const cuts = new Set<number>();
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i]!;
    if (c === '\n') cuts.add(i);
    else if (c === ';' || c === '}') cuts.add(i + 1);
  }
  return [...cuts]
    .filter((cut) => cut > 0 && cut < candidate.length)
    .sort((a, b) => b - a)
    .map((cut) => candidate.slice(0, cut).trimEnd())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
}

export async function validateCompletion(input: CompletionValidationInput): Promise<CompletionValidationResult> {
  const result = await validateOne(input);
  if (result.ok || (result.reason !== 'syntax' && result.reason !== 'unbalanced')) return result;

  // Providers occasionally append a broken second statement to an otherwise
  // useful completion. Recover only structural/syntax failures; semantic
  // filters (echo, overlap, unknown member) remain hard rejections.
  for (const candidate of salvagePrefixes(input.candidate)) {
    const salvaged = await validateOne({ ...input, candidate });
    if (salvaged.ok) return { ok: true, candidate, salvaged: true };
  }
  return result;
}

export function offsetAt(content: string, line: number, col: number): number {
  if (line <= 1) return Math.max(0, col - 1);
  let offset = 0;
  let current = 1;
  while (current < line && offset < content.length) {
    const next = content.indexOf('\n', offset);
    if (next < 0) return content.length;
    offset = next + 1;
    current++;
  }
  return Math.min(content.length, offset + Math.max(0, col - 1));
}

export const __validateCompletionTest = { balanceOk, firstMember, salvagePrefixes };
