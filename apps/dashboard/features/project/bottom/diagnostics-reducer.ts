/**
 * Pure accumulator for the project-wide Problems panel.
 *
 * `lsp.diagnosticsStream` pushes frames COALESCED per (file, source): each
 * frame carries the full current diagnostics for that pair, and an empty
 * `diagnostics: []` clears that source (a backend "all good now" signal).
 * We mirror that into a nested Map so distinct producers (ts / lsp:* / index)
 * never clobber each other, then flatten to a flat, sorted row list for the UI.
 *
 * No React, no I/O — unit-testable on its own (the hook is the only consumer).
 */
import type { DiagnosticItem, DiagnosticsFrame } from '@mcp/api-bus';

export type Severity = DiagnosticItem['severity']; // 'error' | 'warning' | 'info' | 'hint'

export interface ProblemRow {
  /** Project-relative forward-slash path (the diagnostics frame key). */
  file: string;
  source: string;
  severity: Severity;
  message: string;
  /** 1-based, Monaco-compatible (the push path already reports 1-based). */
  line: number;
  column: number;
  code?: string | number;
}

/** file → source → latest diagnostics for that source. */
export type DiagnosticsState = Map<string, Map<string, DiagnosticItem[]>>;

export function emptyDiagnosticsState(): DiagnosticsState {
  return new Map();
}

/**
 * Apply a wire batch with one outer Map copy and at most one inner copy per
 * touched file. Frames retain their stream order, so repeated (file, source)
 * entries remain latest-wins and `diagnostics: []` still clears that source.
 */
export function applyFrames(state: DiagnosticsState, frames: readonly DiagnosticsFrame[]): DiagnosticsState {
  if (frames.length === 0) return state;
  const next = new Map(state);
  const touched = new Map<string, Map<string, DiagnosticItem[]>>();
  for (const frame of frames) {
    let bySource = touched.get(frame.file);
    if (!bySource) {
      bySource = new Map(next.get(frame.file) ?? []);
      touched.set(frame.file, bySource);
    }
    if (frame.diagnostics.length === 0) bySource.delete(frame.source);
    else bySource.set(frame.source, frame.diagnostics);
    if (bySource.size === 0) next.delete(frame.file);
    else next.set(frame.file, bySource);
  }
  return next;
}

/** Apply one frame while retaining the existing producer/test API. */
export function applyFrame(state: DiagnosticsState, frame: DiagnosticsFrame): DiagnosticsState {
  return applyFrames(state, [frame]);
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

export interface FlatDiagnostics {
  items: ProblemRow[];
  errorCount: number;
  warningCount: number;
}

/** Flatten to a list ordered by severity → file → line → column. */
export function flatten(state: DiagnosticsState): FlatDiagnostics {
  const items: ProblemRow[] = [];
  for (const [file, bySource] of state) {
    for (const [source, diags] of bySource) {
      for (const d of diags) {
        items.push({
          file,
          source,
          severity: d.severity,
          message: d.message,
          line: d.range.start.line,
          column: d.range.start.column,
          code: d.code,
        });
      }
    }
  }
  items.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column,
  );
  let errorCount = 0;
  let warningCount = 0;
  for (const it of items) {
    if (it.severity === 'error') errorCount++;
    else if (it.severity === 'warning') warningCount++;
  }
  return { items, errorCount, warningCount };
}
