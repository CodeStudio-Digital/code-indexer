import { describe, it, expect } from 'vitest';
import { parsePosixFrame, parsePosixRow, parsePsDurationMs } from '../process-census/parse-posix.js';

const AT = 1_700_000_000_000;

describe('parsePsDurationMs', () => {
  it('parses every shape ps emits', () => {
    expect(parsePsDurationMs('00:12')).toBe(12_000);
    expect(parsePsDurationMs('01:02:03')).toBe(3_723_000);
    expect(parsePsDurationMs('1-02:03:04')).toBe(93_784_000);
  });

  it('rejects placeholders and garbage', () => {
    expect(parsePsDurationMs('-')).toBeNull();
    expect(parsePsDurationMs('')).toBeNull();
    expect(parsePsDurationMs('12')).toBeNull();
    expect(parsePsDurationMs('a:b')).toBeNull();
  });
});

describe('parsePosixRow', () => {
  it('keeps args containing spaces as one command', () => {
    // `comm` is the bare executable, `args` the full command line — ps emits both.
    const parsed = parsePosixRow(
      '  4242  4200  65536 00:00:30       05:00 node node /home/u/my project/node_modules/.bin/vite --host',
      AT,
    );
    expect(parsed?.row).toMatchObject({
      pid: 4242,
      ppid: 4200,
      exe: 'node',
      workingSetBytes: 65_536 * 1024, // ps reports RSS in KB
      cpuTimeMs: 30_000,
    });
    expect(parsed?.command).toBe('node /home/u/my project/node_modules/.bin/vite --host');
  });

  it('derives a start timestamp from elapsed time', () => {
    const parsed = parsePosixRow('  10  1  1024 00:00:01       01:00 sh sh -c true', AT);
    expect(parsed?.row.createdAtMs).toBe(AT - 60_000);
  });

  it('rejects headers and malformed rows', () => {
    expect(parsePosixRow('  PID  PPID   RSS TIME ELAPSED COMM ARGS', AT)).toBeNull();
    expect(parsePosixRow('', AT)).toBeNull();
    expect(parsePosixRow('  1  0  100 nope 01:00 init /sbin/init', AT)).toBeNull();
  });
});

describe('parsePosixFrame', () => {
  it('parses a multi-line ps dump and skips noise', () => {
    const stdout = [
      '    1     0   9000 00:01:00    10-00:00:00 systemd /sbin/init',
      '',
      ' 4242  4200  65536 00:00:30          05:00 node node vite --host',
      'ps: some warning',
    ].join('\n');
    const frame = parsePosixFrame(stdout, AT);
    expect(frame.at).toBe(AT);
    expect(frame.rows.map((r) => r.pid)).toEqual([1, 4242]);
    expect(frame.commandLines.get(4242)).toBe('node vite --host');
  });
});
