/**
 * Minimal SARIF 2.1.0 subset — the unified diagnostics schema for the external
 * linter adapter (qodana's "one schema for LSP + linters + own rules"). Every
 * tool's output is normalized to a `SarifRun` (by a per-tool parser), then
 * converted ONCE here to the editor's `DiagnosticItem`/`WorkspaceEditDTO`.
 *
 * Contract: ALL line/column are **1-based** (SARIF's own convention and the
 * whole diagnostics pipeline's). We keep only the fields our linters emit.
 */
import type { DiagnosticItem, WorkspaceEditDTO, TextEditDTO } from '@mcp/api-bus';

export interface SarifRegion {
  /** 1-based. */
  startLine: number;
  /** 1-based; defaults to 1 when a tool reports line-only. */
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface SarifReplacement {
  deletedRegion: SarifRegion;
  insertedContent?: { text: string };
}

export interface SarifResult {
  ruleId?: string;
  level?: 'error' | 'warning' | 'note' | 'none';
  message: { text: string };
  region: SarifRegion;
  /** Precomputed edits (eslint/stylelint `fix`, ruff `--fix`) — used by A6 quick-fix. */
  fixes?: SarifReplacement[];
}

export interface SarifRun {
  /** Our tool label (e.g. 'stylelint') — becomes the diagnostic source + marker owner suffix. */
  tool: string;
  results: SarifResult[];
}

function levelToSeverity(level: SarifResult['level']): DiagnosticItem['severity'] {
  switch (level) {
    case 'error': return 'error';
    case 'note': return 'info';
    case 'none': return 'hint';
    case 'warning': default: return 'warning';
  }
}

/** SARIF region → 1-based DTO range, filling line-only reports with column 1. */
export function regionToRange(r: SarifRegion): DiagnosticItem['range'] {
  const startLine = Math.max(1, r.startLine);
  const startColumn = Math.max(1, r.startColumn ?? 1);
  const endLine = Math.max(startLine, r.endLine ?? startLine);
  // endColumn defaults to start (a zero-width marker Monaco widens to the word).
  const endColumn = Math.max(1, r.endColumn ?? startColumn);
  return { start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn } };
}

/** Convert a parsed run to the editor's diagnostics for one project-relative file. */
export function sarifToDiagnostics(run: SarifRun, relFile: string): DiagnosticItem[] {
  return run.results.map((r) => ({
    file: relFile,
    range: regionToRange(r.region),
    severity: levelToSeverity(r.level),
    message: r.message.text,
    source: run.tool,
    ...(r.ruleId ? { code: r.ruleId } : {}),
  }));
}

/**
 * Convert a result's SARIF fixes to a Monaco workspace edit for `absFile`
 * (A6 quick-fix). Returns null when the result carries no fix. Absolute path +
 * 1-based ranges match the `WorkspaceEditDTO` contract.
 */
export function sarifFixesToEdits(result: SarifResult, absFile: string): WorkspaceEditDTO | null {
  if (!result.fixes || result.fixes.length === 0) return null;
  const edits: TextEditDTO[] = result.fixes.map((f) => ({
    range: regionToRange(f.deletedRegion),
    newText: f.insertedContent?.text ?? '',
  }));
  return { changes: { [absFile]: edits } };
}
