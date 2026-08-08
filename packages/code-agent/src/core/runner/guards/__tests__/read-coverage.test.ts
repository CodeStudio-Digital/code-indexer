/**
 * Tests for the P1b coverage-aware read ledger.
 *
 * Contracts under test (each maps to a telemetry-diagnosed failure mode):
 *  - subsumption: overlapping ranges that evade the exact-slice dedup key
 *    ARE detected (1-130 then 15-230 then 120-135 → covered);
 *  - gaps never claim coverage (paging through a big file stays allowed);
 *  - adjacency counts (1-10 + 11-20 covers 1-20);
 *  - mutation clears a path's coverage;
 *  - mtime validation: segments observed at a different file mtime never
 *    satisfy a validated query (edits made outside the session);
 *  - parseServedRange only trusts the dual header (`| N lines` + `[lines A-B]`).
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  ReadCoverageLedger,
  parseServedRange,
  buildCoveragePointer,
  readCoverageEnabled,
  visibleSpanOf,
} from '@mcp/code-agent/core/runner/guards/read-coverage.js';

const seg = (start: number, end: number, turn = 1, mtimeMs?: number) => ({
  start,
  end,
  turn,
  useId: `u${start}-${end}-${turn}`,
  mtimeMs,
});

describe('ReadCoverageLedger.coveringSegments', () => {
  it('detects full subsumption across overlapping segments', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.php', seg(1, 130, 1));
    l.noteServed('a.php', seg(15, 230, 2));
    const cov = l.coveringSegments('a.php', 120, 135);
    expect(cov).not.toBeNull();
    expect(cov!.length).toBeGreaterThan(0);
  });

  it('returns null on a gap (paging is never blocked)', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.php', seg(1, 100, 1));
    l.noteServed('a.php', seg(200, 300, 2));
    expect(l.coveringSegments('a.php', 50, 250)).toBeNull();
    expect(l.coveringSegments('a.php', 101, 199)).toBeNull();
  });

  it('treats adjacent segments as contiguous', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.ts', seg(1, 10, 1));
    l.noteServed('a.ts', seg(11, 20, 2));
    const cov = l.coveringSegments('a.ts', 1, 20);
    expect(cov).not.toBeNull();
    expect(cov!.map((s) => s.useId)).toEqual(['u1-10-1', 'u11-20-2']);
  });

  it('mutation clears the path (and only that path)', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.ts', seg(1, 100, 1));
    l.noteServed('b.ts', seg(1, 100, 1));
    l.noteMutation('a.ts');
    expect(l.coveringSegments('a.ts', 1, 50)).toBeNull();
    expect(l.coveringSegments('b.ts', 1, 50)).not.toBeNull();
  });

  it('mtime validation excludes segments from other file versions', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.ts', seg(1, 100, 1, 1000));
    expect(l.coveringSegments('a.ts', 1, 50, { requireMtimeMs: 1000 })).not.toBeNull();
    expect(l.coveringSegments('a.ts', 1, 50, { requireMtimeMs: 2000 })).toBeNull();
    // Segments with NO recorded mtime never satisfy a validated query.
    l.noteServed('c.ts', seg(1, 100, 1));
    expect(l.coveringSegments('c.ts', 1, 50, { requireMtimeMs: 1000 })).toBeNull();
  });

  it('rejects degenerate ranges', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.ts', seg(0, 10, 1)); // invalid start ignored
    expect(l.coveringSegments('a.ts', 1, 5)).toBeNull();
    expect(l.coveringSegments('a.ts', 5, 1)).toBeNull();
  });
});

describe('parseServedRange', () => {
  it('parses the native/MCP dual header', () => {
    const raw = 'src/x.ts | 812 lines | ts\n[lines 15-230]\n   15\tcode...';
    expect(parseServedRange(raw)).toEqual({ fileLines: 812, start: 15, end: 230 });
  });

  it('is case-insensitive on the header markers', () => {
    const raw = 'src/x.ts | 812 Lines | ts\n[Lines 15-230]\n15\tcode...';
    expect(parseServedRange(raw)).toEqual({ fileLines: 812, start: 15, end: 230 });
  });

  it('returns null without the [lines] tag (skeletons, symbol bodies, diffs)', () => {
    expect(parseServedRange('src/x.ts | ts | domain | 812L | 12')).toBeNull();
    expect(parseServedRange('x.ts — symbol body (lines 3-9 of 100)\ncode')).toBeNull();
    expect(parseServedRange('[reread-after-edit] `x.ts` was mutated...')).toBeNull();
  });

  it('returns null on malformed windows', () => {
    expect(parseServedRange('x | 10 lines | ts\n[lines 9-3]\n')).toBeNull();
  });
});

describe('buildCoveragePointer', () => {
  it('is deterministic and names the covering turns', () => {
    const txt = buildCoveragePointer({
      toolName: 'read_file',
      path: 'a.php',
      start: 120,
      end: 135,
      segments: [seg(1, 130, 3), seg(15, 230, 7)],
    });
    expect(txt).toContain('[already-read]');
    expect(txt).toContain('lines 120-135');
    expect(txt).toContain('turn 3');
    expect(txt).toContain('turn 7');
    expect(txt).toContain('force_reread');
  });
});

describe('readCoverageEnabled', () => {
  afterEach(() => {
    delete process.env.CODER_READ_COVERAGE_DISABLE;
  });
  it('cannot be disabled by the retired kill switch', () => {
    expect(readCoverageEnabled()).toBe(true);
    process.env.CODER_READ_COVERAGE_DISABLE = '1';
    expect(readCoverageEnabled()).toBe(true);
  });
});

/** Numbered read body, native (padded) or MCP (unpadded) flavour. */
function body(start: number, end: number, padded = true): string {
  return Array.from({ length: end - start + 1 }, (_, i) => {
    const n = start + i;
    return `${padded ? n.toString().padStart(5) : String(n)}\tline ${n}`;
  }).join('\n');
}

describe('visibleSpanOf', () => {
  it('parses the native padded body', () => {
    const content = `a.ts | 1000 lines | ts\n[lines 550-1000]\n${body(550, 1000)}`;
    expect(visibleSpanOf(content)).toEqual({ start: 550, end: 1000 });
  });

  it('parses the MCP unpadded body and skips header notes', () => {
    const content =
      'spec/app-spec.json | 1000 lines | json | layer=unknown\n' +
      '[lines 760-850] [auto-full off — file > 800 lines, pass force=true to read all]\n' +
      '[Auto-scrolled to line 760 matching "behaviors"]\n' +
      body(760, 850, false);
    expect(visibleSpanOf(content)).toEqual({ start: 760, end: 850 });
  });

  it('a tail-truncated body reports only the lines still present (the 2026-07-09 lie)', () => {
    const content =
      `spec/app-spec.json | 1000 lines | json\n[lines 550-1000]\n${body(550, 761)}\n` +
      '[truncated — 12000 more chars. get_tool_output("out_1") for the rest]';
    expect(visibleSpanOf(content)).toEqual({ start: 550, end: 761 });
  });

  it('stops at a mid-content break (elided middle chunks never extend the span)', () => {
    const content =
      `a.ts | 300 lines | ts\n[lines 1-300]\n${body(1, 50)}\n[…elided…]\n${body(200, 300)}`;
    expect(visibleSpanOf(content)).toEqual({ start: 1, end: 50 });
  });

  it('ignores the footer after the body', () => {
    const content =
      `a.ts | 900 lines | ts\n[lines 1-100]\n${body(1, 100)}\n` +
      '... [800 more lines — pass force=true, a start_line/end_line range, or symbol]';
    expect(visibleSpanOf(content)).toEqual({ start: 1, end: 100 });
  });

  it('returns null for diffs / pointers / empty content (nothing quotable as lines)', () => {
    expect(visibleSpanOf('[already-read] `a.ts` lines 1-10 are already in your context')).toBeNull();
    expect(
      visibleSpanOf('[reread-after-edit] `x.ts` was mutated...\n@@ -1,3 +1,3 @@\n-a\n+b'),
    ).toBeNull();
    expect(visibleSpanOf('')).toBeNull();
  });
});

describe('coveringSegments — liveSpanOf (honesty rule)', () => {
  it('mirrors the screenshot: ledger says 550-1000, live content ends at 761', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('spec/app-spec.json', seg(550, 1000, 11, 5000));
    const liveSpanOf = () => ({ start: 550, end: 761 }); // what the cap left visible
    // 760-900 reaches past the visible span → must NOT claim coverage.
    expect(
      l.coveringSegments('spec/app-spec.json', 760, 900, { requireMtimeMs: 5000, liveSpanOf }),
    ).toBeNull();
    // 600-750 is fully visible → the pointer is honest.
    expect(
      l.coveringSegments('spec/app-spec.json', 600, 750, { requireMtimeMs: 5000, liveSpanOf }),
    ).not.toBeNull();
  });

  it('a segment whose tool_result is gone/elided/unparseable contributes nothing', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.ts', seg(1, 100, 1));
    expect(l.coveringSegments('a.ts', 1, 50, { liveSpanOf: () => null })).toBeNull();
  });

  it('union over live spans still covers when trims leave enough', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.ts', seg(1, 100, 1));
    l.noteServed('a.ts', seg(80, 200, 2));
    const liveSpanOf = (s: { useId: string }) =>
      s.useId === 'u1-100-1' ? { start: 1, end: 90 } : { start: 80, end: 200 };
    expect(l.coveringSegments('a.ts', 50, 150, { liveSpanOf })).not.toBeNull();
  });

  it('a trim that opens a gap between segments breaks coverage', () => {
    const l = new ReadCoverageLedger();
    l.noteServed('a.ts', seg(1, 100, 1));
    l.noteServed('a.ts', seg(80, 200, 2));
    const liveSpanOf = (s: { useId: string }) =>
      s.useId === 'u1-100-1' ? { start: 1, end: 60 } : { start: 80, end: 200 };
    expect(l.coveringSegments('a.ts', 50, 150, { liveSpanOf })).toBeNull();
  });
});
