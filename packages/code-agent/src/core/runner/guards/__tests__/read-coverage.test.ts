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
  it('kill switch works', () => {
    expect(readCoverageEnabled()).toBe(true);
    process.env.CODER_READ_COVERAGE_DISABLE = '1';
    expect(readCoverageEnabled()).toBe(false);
  });
});
