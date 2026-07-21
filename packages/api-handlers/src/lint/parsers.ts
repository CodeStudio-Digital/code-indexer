/**
 * Per-tool output parsers → the unified `SarifRun`. Each linter speaks its own
 * JSON; we normalize here so `sarif.ts` is the single conversion point. Parsers
 * are pure and defensive: malformed/partial JSON throws (the runner treats a
 * throw as "no result", never clobbering existing diagnostics).
 */
import type { SarifRun, SarifResult } from './sarif.js';

/** stylelint `--formatter json`: array of file results with `warnings[]`. */
interface StylelintWarning {
  line: number; column: number; endLine?: number; endColumn?: number;
  rule?: string; severity?: 'error' | 'warning'; text: string;
}
interface StylelintFileResult {
  warnings?: StylelintWarning[];
  parseErrors?: Array<{ line: number; column: number; text: string }>;
}

export function parseStylelintJson(stdout: string): SarifRun {
  const parsed = JSON.parse(stdout) as StylelintFileResult[];
  const results: SarifResult[] = [];
  for (const file of parsed ?? []) {
    for (const w of file.warnings ?? []) {
      results.push({
        ruleId: w.rule,
        level: w.severity === 'error' ? 'error' : 'warning',
        message: { text: w.text },
        region: { startLine: w.line, startColumn: w.column, endLine: w.endLine, endColumn: w.endColumn },
      });
    }
    // Syntax/parse errors (invalid CSS) surface as errors too.
    for (const e of file.parseErrors ?? []) {
      results.push({ level: 'error', message: { text: e.text }, region: { startLine: e.line, startColumn: e.column } });
    }
  }
  return { tool: 'stylelint', results };
}

/** eslint `-f json`: array of file results with `messages[]` (severity 1=warn, 2=error). */
interface EslintMessage {
  ruleId?: string | null; severity: 1 | 2; message: string;
  line?: number; column?: number; endLine?: number; endColumn?: number;
}
interface EslintFileResult { messages?: EslintMessage[]; }

export function parseEslintJson(stdout: string): SarifRun {
  const parsed = JSON.parse(stdout) as EslintFileResult[];
  const results: SarifResult[] = [];
  for (const file of parsed ?? []) {
    for (const m of file.messages ?? []) {
      results.push({
        ruleId: m.ruleId ?? undefined,
        level: m.severity === 2 ? 'error' : 'warning',
        message: { text: m.message },
        // A whole-file error (parse failure, ruleId null) can arrive line-less.
        region: { startLine: m.line ?? 1, startColumn: m.column, endLine: m.endLine, endColumn: m.endColumn },
      });
    }
  }
  return { tool: 'eslint', results };
}
