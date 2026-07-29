import { describe, it, expect } from 'vitest';
import type { CensusTree } from '@mcp/shared/utils/process-census/tree.js';
import type { DerivedRates, RawProcessRow } from '@mcp/shared/utils/process-census/types.js';
import {
  buildTaskRows,
  kindFromElectronType,
  type BuildTaskRowsInput,
  type ElectronProcessInfo,
} from '../task-rows.js';

const MB = 1024 * 1024;

function node(pid: number, ppid: number, depth: number, mb: number, orphaned = false) {
  const row: RawProcessRow = {
    pid,
    ppid,
    exe: `p${pid}.exe`,
    workingSetBytes: mb * MB,
    cpuTimeMs: 0,
    createdAtMs: 1,
  };
  return { row, depth, orphaned };
}

function input(over: Partial<BuildTaskRowsInput> = {}): BuildTaskRowsInput {
  const tree: CensusTree = { ordered: [], descendants: new Set() };
  return {
    tree,
    rates: new Map<number, DerivedRates>(),
    commandLines: new Map<number, string>(),
    mainPid: 100,
    electronByPid: new Map<number, ElectronProcessInfo>(),
    labels: new Map(),
    workers: [],
    ...over,
  };
}

describe('kindFromElectronType', () => {
  it('maps Electron process types onto task kinds', () => {
    expect(kindFromElectronType('Browser')).toBe('main');
    expect(kindFromElectronType('GPU')).toBe('gpu');
    expect(kindFromElectronType('Tab')).toBe('renderer');
    expect(kindFromElectronType('Utility')).toBe('utility');
    expect(kindFromElectronType('Pepper Plugin')).toBe('unknown');
  });
});

describe('buildTaskRows', () => {
  it('projects the census tree, keeping depth and converting to MB', () => {
    const tree: CensusTree = {
      ordered: [node(100, 1, 0, 500), node(200, 100, 1, 40)],
      descendants: new Set([100, 200]),
    };
    const rows = buildTaskRows(input({ tree }));
    expect(rows.map((r) => [r.id, r.depth, r.memoryMB])).toEqual([
      ['os:100', 0, 500],
      ['os:200', 1, 40],
    ]);
    expect(rows[0]!.kind).toBe('main');
  });

  it('prefers a registry label over the Electron name over the executable', () => {
    const tree: CensusTree = {
      ordered: [node(100, 1, 0, 10), node(200, 100, 1, 10), node(300, 100, 1, 10)],
      descendants: new Set([100, 200, 300]),
    };
    const rows = buildTaskRows(input({
      tree,
      labels: new Map([[200, { kind: 'terminal' as const, label: 'Terminal: app', ownerId: 't1' }]]),
      electronByPid: new Map([[300, { type: 'Tab', name: 'Dashboard', workingSetMB: 9, cpuPercent: 1 }]]),
    }));
    expect(rows[1]).toMatchObject({ label: 'Terminal: app', kind: 'terminal', ownerId: 't1' });
    expect(rows[2]).toMatchObject({ label: 'Dashboard', kind: 'renderer' });
  });

  it('falls back to Electron CPU only until the census can derive its own', () => {
    const tree: CensusTree = { ordered: [node(100, 1, 0, 10)], descendants: new Set([100]) };
    const electronByPid = new Map([[100, { type: 'Browser', name: 'main', workingSetMB: 9, cpuPercent: 7 }]]);
    expect(buildTaskRows(input({ tree, electronByPid }))[0]!.cpuPercent).toBe(7);

    const rates = new Map([[100, { cpuPercent: 22, diskBytesPerSec: 1_000 }]]);
    const derived = buildTaskRows(input({ tree, electronByPid, rates }))[0]!;
    expect(derived.cpuPercent).toBe(22);
    expect(derived.diskBytesPerSec).toBe(1_000);
  });

  it('renders Electron-only rows when the collector has produced nothing', () => {
    const rows = buildTaskRows(input({
      electronByPid: new Map<number, ElectronProcessInfo>([
        [100, { type: 'Browser', name: 'main', workingSetMB: 300, cpuPercent: 2 }],
        [400, { type: 'GPU', name: 'GPU', workingSetMB: 80, cpuPercent: 1 }],
      ]),
    }));
    expect(rows.map((r) => r.id)).toEqual(['electron:100', 'electron:400']);
    expect(rows.every((r) => r.source === 'electron')).toBe(true);
    expect(rows[1]!.depth).toBe(1);
  });

  it('nests worker isolates under main and keeps them out of the total', () => {
    const tree: CensusTree = {
      ordered: [node(100, 1, 0, 500), node(200, 100, 1, 40)],
      descendants: new Set([100, 200]),
    };
    const rows = buildTaskRows(input({
      tree,
      workers: [{ id: 'indexer', label: 'indexer', heapUsedMB: 120 }],
    }));
    expect(rows.map((r) => r.id)).toEqual(['os:100', 'worker:indexer', 'os:200']);
    const worker = rows[1]!;
    expect(worker).toMatchObject({ depth: 1, pid: 100, countsTowardTotal: false, kind: 'worker' });
  });

  it('marks adopted subtrees as orphaned', () => {
    const tree: CensusTree = {
      ordered: [node(100, 1, 0, 10), node(900, 1, 0, 30, true)],
      descendants: new Set([100, 900]),
    };
    const rows = buildTaskRows(input({ tree }));
    expect(rows[1]!.orphaned).toBe(true);
  });
});
