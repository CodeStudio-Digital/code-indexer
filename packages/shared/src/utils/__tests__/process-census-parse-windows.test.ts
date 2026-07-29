import { describe, it, expect } from 'vitest';
import {
  createWindowsFrameAssembler,
  parseWindowsCommandLine,
  parseWindowsProcessLine,
} from '../process-census/parse-windows.js';

// pid ppid exe ws priv kernel100ns user100ns read write createdMs
const P = (pid: number, ppid: number, exe: string, extra = ''): string =>
  `#P\t${pid}\t${ppid}\t${exe}\t1048576\t524288\t10000000\t20000000\t4096\t2048\t1700000000000${extra}`;

describe('parseWindowsProcessLine', () => {
  it('converts 100ns kernel+user ticks into milliseconds', () => {
    const row = parseWindowsProcessLine(P(1234, 10, 'node.exe'));
    // (10_000_000 + 20_000_000) ticks / 10_000 = 3000ms
    expect(row).toMatchObject({ pid: 1234, ppid: 10, exe: 'node.exe', cpuTimeMs: 3000 });
    expect(row?.workingSetBytes).toBe(1_048_576);
    expect(row?.createdAtMs).toBe(1_700_000_000_000);
  });

  it('rejects truncated, mistyped and non-process lines', () => {
    expect(parseWindowsProcessLine('#P\t1234\t10\tnode.exe')).toBeNull();
    expect(parseWindowsProcessLine(P(0, 10, 'x.exe'))).toBeNull();
    expect(parseWindowsProcessLine('#E\t1700000000000')).toBeNull();
    expect(parseWindowsProcessLine('WARNING: something')).toBeNull();
  });

  it('treats empty numeric fields as zero rather than NaN', () => {
    const row = parseWindowsProcessLine('#P\t99\t\tnode.exe\t\t\t\t\t\t\t');
    expect(row).toMatchObject({ pid: 99, ppid: 0, workingSetBytes: 0, cpuTimeMs: 0 });
  });
});

describe('parseWindowsCommandLine', () => {
  it('preserves a command line containing tabs', () => {
    const entry = parseWindowsCommandLine('#C\t42\tnode\t--inspect app.js');
    expect(entry).toEqual({ pid: 42, command: 'node\t--inspect app.js' });
  });

  it('keeps non-ASCII paths intact', () => {
    const entry = parseWindowsCommandLine('#C\t7\tC:\\Usuários\\maicon\\projeto\\ação.exe');
    expect(entry?.command).toBe('C:\\Usuários\\maicon\\projeto\\ação.exe');
  });
});

describe('createWindowsFrameAssembler', () => {
  it('emits a frame only when #E closes it', () => {
    const asm = createWindowsFrameAssembler();
    expect(asm.push(P(1, 0, 'main.exe'))).toBeNull();
    expect(asm.push('#C\t1\tmain.exe --serve')).toBeNull();
    const frame = asm.push('#E\t1700000005000');
    expect(frame?.at).toBe(1_700_000_005_000);
    expect(frame?.rows).toHaveLength(1);
    expect(frame?.commandLines.get(1)).toBe('main.exe --serve');
  });

  it('starts a clean frame after each emission', () => {
    const asm = createWindowsFrameAssembler();
    asm.push(P(1, 0, 'main.exe'));
    asm.push('#E\t1700000005000');
    asm.push(P(2, 1, 'git.exe'));
    const second = asm.push('#E\t1700000007000');
    expect(second?.rows.map((r) => r.pid)).toEqual([2]);
  });

  it('never emits a frame with zero rows (a failed query inside the loop)', () => {
    const asm = createWindowsFrameAssembler();
    expect(asm.push('#E\t1700000005000')).toBeNull();
  });

  it('drops a truncated frame instead of merging it into the next one', () => {
    const asm = createWindowsFrameAssembler();
    asm.push(P(1, 0, 'main.exe'));
    asm.reset(); // collector died mid-emission
    asm.push(P(2, 1, 'git.exe'));
    const frame = asm.push('#E\t1700000009000');
    expect(frame?.rows.map((r) => r.pid)).toEqual([2]);
  });

  it('ignores stray stdout noise', () => {
    const asm = createWindowsFrameAssembler();
    expect(asm.push('')).toBeNull();
    expect(asm.push('At line:1 char:1')).toBeNull();
    asm.push(P(1, 0, 'main.exe'));
    expect(asm.push('#E\t1700000005000')?.rows).toHaveLength(1);
  });
});
