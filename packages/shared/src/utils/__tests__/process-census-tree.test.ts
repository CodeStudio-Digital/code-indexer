import { describe, it, expect } from 'vitest';
import { buildDescendantTree } from '../process-census/tree.js';
import type { RawProcessRow } from '../process-census/types.js';

const AT = 1_700_000_000_000;

function row(
  pid: number,
  ppid: number,
  over: Partial<RawProcessRow> = {},
): RawProcessRow {
  return {
    pid,
    ppid,
    exe: `p${pid}.exe`,
    workingSetBytes: 1024,
    cpuTimeMs: 0,
    createdAtMs: AT,
    ...over,
  };
}

describe('buildDescendantTree', () => {
  it('walks the whole chain: main → terminal → npm → vite → esbuild', () => {
    const rows = [
      row(100, 1),                              // main
      row(200, 100, { createdAtMs: AT + 1_000 }), // terminal
      row(300, 200, { createdAtMs: AT + 2_000 }), // npm run dev
      row(400, 300, { createdAtMs: AT + 3_000 }), // vite
      row(500, 400, { createdAtMs: AT + 4_000 }), // esbuild
      row(999, 1),                              // unrelated system process
    ];
    const { ordered, descendants } = buildDescendantTree(rows, 100);
    expect(ordered.map((n) => n.row.pid)).toEqual([100, 200, 300, 400, 500]);
    expect(ordered.map((n) => n.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(descendants.has(999)).toBe(false);
  });

  it('terminates on a PPID cycle', () => {
    const rows = [row(100, 1), row(200, 100), row(100, 200)];
    const { ordered } = buildDescendantTree(rows, 100);
    expect(ordered).toHaveLength(2);
  });

  it('refuses to adopt a child that predates its parent (recycled pid)', () => {
    const rows = [
      row(100, 1, { createdAtMs: AT }),
      // A long-running system process whose parent pid was later reused by main.
      row(700, 100, { createdAtMs: AT - 3_600_000 }),
    ];
    const { descendants } = buildDescendantTree(rows, 100);
    expect(descendants.has(700)).toBe(false);
  });

  it('sorts siblings by memory then pid, stably across identical frames', () => {
    const rows = [
      row(100, 1),
      row(201, 100, { workingSetBytes: 10 }),
      row(202, 100, { workingSetBytes: 900 }),
      row(203, 100, { workingSetBytes: 900 }),
    ];
    const first = buildDescendantTree(rows, 100).ordered.map((n) => n.row.pid);
    const second = buildDescendantTree([...rows].reverse(), 100).ordered.map((n) => n.row.pid);
    expect(first).toEqual([100, 202, 203, 201]);
    expect(second).toEqual(first);
  });

  it('adopts still-owned pids whose parent already died, with their subtree', () => {
    const rows = [
      row(100, 1),
      // Terminal is gone; vite survived and reparented to pid 1.
      row(400, 1, { createdAtMs: AT + 3_000, workingSetBytes: 5_000 }),
      row(500, 400, { createdAtMs: AT + 4_000 }),
    ];
    const { ordered, descendants } = buildDescendantTree(rows, 100, [400]);
    expect(ordered.map((n) => n.row.pid)).toEqual([100, 400, 500]);
    expect(ordered.find((n) => n.row.pid === 400)?.orphaned).toBe(true);
    expect(ordered.find((n) => n.row.pid === 500)?.orphaned).toBe(true);
    expect(ordered.find((n) => n.row.pid === 100)?.orphaned).toBe(false);
    expect(descendants.has(500)).toBe(true);
  });

  it('ignores adopted pids that are already in the main tree or already gone', () => {
    const rows = [row(100, 1), row(200, 100)];
    const { ordered } = buildDescendantTree(rows, 100, [200, 4242]);
    expect(ordered.map((n) => n.row.pid)).toEqual([100, 200]);
    expect(ordered.every((n) => !n.orphaned)).toBe(true);
  });

  it('returns an empty tree when the main pid is missing from the frame', () => {
    const { ordered, descendants } = buildDescendantTree([row(999, 1)], 100);
    expect(ordered).toEqual([]);
    expect(descendants.size).toBe(0);
  });
});
