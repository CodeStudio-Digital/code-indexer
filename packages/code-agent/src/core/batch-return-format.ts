/**
 * Readable rendering, fair truncation and budgeting for batched returns
 * (`code_exec` → `return await Promise.all([...])`).
 *
 * Three defects made batching expensive in the 3.16.24 Ky run:
 *   1. Tool outputs were returned as one JSON string: every newline, tab and
 *      quote escaped (`\n\t\t\"x\"`), inflating size and hiding indentation
 *      the model later had to reproduce in patches.
 *   2. The final cap kept the head and tail of the whole payload, dropping
 *      the middle values entirely — six of eight files vanished in one call
 *      and were re-read over the next three rounds.
 *   3. One block of N tool results received the budget of ONE tool result,
 *      while the same N reads issued as separate calls each get a full cap.
 *
 * Every function here is deterministic so live and resumed histories stay
 * byte-identical (prompt-cache prefix stability).
 */

/** Batched return blocks may use up to this many single-result budgets. */
export const MAX_BATCH_BUDGET_UNITS = 4;

const SECTION_LINE = /^── (\[\d+\]|"(?:[^"\\]|\\.)*") ──$/;
const HEADER_LINE = /^(array|object)\((\d+)\): values in (order|key order)$/;

function isTextual(value: unknown): value is string {
  return typeof value === 'string' && (value.includes('\n') || value.length > 160);
}

function json(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Render a script's return value. Arrays/objects holding multi-line text are
 * shown as raw labeled sections; everything else keeps compact JSON.
 */
export function renderBatchReturn(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.some(isTextual)) {
    const parts = [`array(${value.length}): values in order`];
    value.forEach((item, i) => parts.push(`── [${i}] ──`, typeof item === 'string' ? item : json(item)));
    return parts.join('\n');
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.some(([, item]) => isTextual(item))) {
      const parts = [`object(${entries.length}): values in key order`];
      for (const [key, item] of entries) parts.push(`── ${JSON.stringify(key)} ──`, typeof item === 'string' ? item : json(item));
      return parts.join('\n');
    }
  }
  return json(value);
}

interface Section { label: string; body: string }

/** Split a rendered sectioned payload; null when it is not one (or ambiguous). */
export function parseBatchReturn(payload: string): { header: string; sections: Section[] } | null {
  const lines = payload.split('\n');
  const header = HEADER_LINE.exec(lines[0] ?? '');
  if (!header) return null;
  const sections: Section[] = [];
  let current: { label: string; body: string[] } | null = null;
  for (const line of lines.slice(1)) {
    const label = SECTION_LINE.exec(line);
    if (label) {
      if (current) sections.push({ label: current.label, body: current.body.join('\n') });
      current = { label: label[0], body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      return null;
    }
  }
  if (current) sections.push({ label: current.label, body: current.body.join('\n') });
  return sections.length === Number(header[2]) ? { header: lines[0], sections } : null;
}

function lineCount(text: string): number {
  let count = text.length > 0 ? 1 : 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

const omissionMarker = (lines: number, chars: number): string =>
  `[… middle of this value omitted: ${lines} lines / ${chars} chars …]`;

function fitBody(body: string, budget: number): string {
  if (body.length <= budget) return body;
  // Size the marker with upper-bound counts so the final one never overflows.
  const room = Math.max(0, budget - omissionMarker(lineCount(body), body.length).length - 2);
  const head = body.slice(0, Math.ceil(room * 0.6));
  const tail = room - head.length > 0 ? body.slice(body.length - (room - head.length)) : '';
  const omitted = body.slice(head.length, body.length - tail.length);
  return `${head}\n${omissionMarker(lineCount(omitted), omitted.length)}\n${tail}`;
}

/**
 * Fit a sectioned payload into `room` chars by water-filling: small values
 * stay whole, large ones share the rest and keep their own head and tail,
 * so every value of the batch stays visible. Null → caller falls back.
 */
export function fitBatchReturn(payload: string, room: number): string | null {
  const parsed = parseBatchReturn(payload);
  if (!parsed) return null;
  const { header, sections } = parsed;
  const fixed = header.length + sections.reduce((sum, s) => sum + s.label.length + 2, 0);
  const minimum = sections.length * 96;
  if (room - fixed < minimum) return null;
  let remaining = room - fixed;
  let left = sections.length;
  const allowance = new Array<number>(sections.length);
  const bySize = sections.map((s, i) => i).sort((a, b) => sections[a].body.length - sections[b].body.length);
  for (const i of bySize) {
    allowance[i] = Math.min(sections[i].body.length, Math.floor(remaining / left));
    remaining -= allowance[i];
    left--;
  }
  const parts = [header];
  sections.forEach((s, i) => parts.push(s.label, fitBody(s.body, allowance[i])));
  return parts.join('\n');
}

/** Number of single-result budgets a tool_result block may use. */
export function batchBudgetUnits(toolName: string | undefined, content: string | undefined): number {
  if (toolName !== 'code_exec' || !content) return 1;
  const calls = /^code_exec: (\d+) tool call\(s\)/.exec(content);
  const n = calls ? Number(calls[1]) : 1;
  return Math.max(1, Math.min(MAX_BATCH_BUDGET_UNITS, Number.isFinite(n) ? n : 1));
}
