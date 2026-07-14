/**
 * Offline autocomplete replay. By default it uses synthetic hidden-tail
 * fixtures; pass --input <jsonl> for locally recorded cases. Project code is
 * never written by this script. JSONL fields: file, language, prefix, suffix,
 * expected, completion, relatedContext?, contextMs?, totalMs?.
 */
import { readFile } from 'node:fs/promises';
import { validateCompletion } from '../packages/api-handlers/src/editor/completion/validate.js';

interface ReplayCase {
  file: string; language: string; prefix: string; suffix: string;
  expected: string; completion: string; relatedContext?: string;
  contextMs?: number; totalMs?: number;
}

const SYNTHETIC: ReplayCase[] = [
  { file: 'math.ts', language: 'typescript', prefix: 'function add(a: number, b: number) {\n  ', suffix: '\n}', expected: 'return a + b;', completion: 'return a + b;', relatedContext: 'function sum(a, b) { return a + b; }', contextMs: 2, totalMs: 3 },
  { file: 'query.php', language: 'php', prefix: '<?php\nfunction normalize($textFilter) {\n  ', suffix: '\n}', expected: '$cpf = applyMaskNumeric($textFilter);', completion: '$cpf = applyMaskNumeric($textFilter);', relatedContext: '$cpf = applyMaskNumeric($textFilter);', contextMs: 3, totalMs: 4 },
  { file: 'clamp.py', language: 'python', prefix: 'def clamp(value, low, high):\n    ', suffix: '\n', expected: 'return max(low, min(value, high))', completion: 'return max(low, min(value, high))', relatedContext: 'bounded = max(low, min(value, high))', contextMs: 1, totalMs: 2 },
];

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function identifiers(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []);
}

function similarity(a: string, b: string): number {
  const aa = a.trim(); const bb = b.trim();
  if (!aa.length && !bb.length) return 1;
  const row = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 1; i <= aa.length; i++) {
    let prev = row[0]!; row[0] = i;
    for (let j = 1; j <= bb.length; j++) {
      const old = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (aa[i - 1] === bb[j - 1] ? 0 : 1));
      prev = old;
    }
  }
  return 1 - row[bb.length]! / Math.max(aa.length, bb.length, 1);
}

async function loadCases(): Promise<ReplayCase[]> {
  const input = arg('--input');
  if (!input) return SYNTHETIC;
  return (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ReplayCase);
}

const cases = await loadCases();
const rows = [];
for (const c of cases) {
  const expectedIds = identifiers(c.expected);
  const contextIds = identifiers(c.relatedContext ?? '');
  const recall = expectedIds.size ? [...expectedIds].filter((id) => contextIds.has(id)).length / expectedIds.size : 1;
  const syntax = await validateCompletion({
    file: c.file, original: c.prefix + c.suffix, candidate: c.completion,
    offset: c.prefix.length, prefix: c.prefix, suffix: c.suffix,
  });
  rows.push({
    file: c.file, contextRecall: recall, nonEmpty: c.completion.trim().length > 0,
    similarity: similarity(c.expected, c.completion), syntaxValid: syntax.ok,
    contextMs: c.contextMs ?? null, totalMs: c.totalMs ?? null,
  });
}
const mean = (field: 'contextRecall' | 'similarity') => rows.reduce((n, r) => n + r[field], 0) / Math.max(1, rows.length);
console.log(JSON.stringify({
  cases: rows.length, contextRecall: mean('contextRecall'),
  nonEmptyRate: rows.filter((r) => r.nonEmpty).length / rows.length,
  continuationSimilarity: mean('similarity'),
  syntaxValidRate: rows.filter((r) => r.syntaxValid).length / rows.length,
  contextP95Ms: rows.map((r) => r.contextMs).filter((n): n is number => n != null).sort((a, b) => a - b).at(-1) ?? null,
  totalP90Ms: rows.map((r) => r.totalMs).filter((n): n is number => n != null).sort((a, b) => a - b).at(Math.floor(rows.length * 0.9)) ?? null,
  rows,
}, null, 2));
