import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRuntimeEnv,
  boundUtf8Output,
  LocalShellAdapter,
} from '../shell-port.js';

describe('applyRuntimeEnv', () => {
  it('returns the base untouched when no runtime env is given', () => {
    const base = { PATH: '/usr/bin', FOO: 'bar' };
    expect(applyRuntimeEnv(base)).toBe(base);
  });

  it('prepends bin dirs to PATH (highest priority first), keeping the original', () => {
    const out = applyRuntimeEnv(
      { PATH: '/usr/bin' },
      { pathPrepend: ['/php/8.3', '/py/3.12'], extraEnv: {} },
    );
    expect(out.PATH).toBe(`/php/8.3${delimiter}/py/3.12${delimiter}/usr/bin`);
  });

  it('merges extraEnv (e.g. PHPRC)', () => {
    const out = applyRuntimeEnv(
      { PATH: '/usr/bin' },
      { pathPrepend: [], extraEnv: { PHPRC: '/php/8.3' } },
    );
    expect(out.PHPRC).toBe('/php/8.3');
    expect(out.PATH).toBe('/usr/bin'); // no prepend → PATH unchanged
  });

  it('normalises a Windows-style `Path` key to `PATH`', () => {
    const out = applyRuntimeEnv(
      { Path: 'C:\\Windows' },
      { pathPrepend: ['C:\\php'], extraEnv: {} },
    );
    expect(out.Path).toBeUndefined();
    expect(out.PATH).toBe(`C:\\php${delimiter}C:\\Windows`);
  });

  it('drops falsy prepend entries', () => {
    const out = applyRuntimeEnv(
      { PATH: '/usr/bin' },
      { pathPrepend: ['', '/php/8.3'], extraEnv: {} },
    );
    expect(out.PATH).toBe(`/php/8.3${delimiter}/usr/bin`);
  });

  it('does not mutate the base env object', () => {
    const base = { PATH: '/usr/bin' };
    applyRuntimeEnv(base, { pathPrepend: ['/php'], extraEnv: { X: '1' } });
    expect(base).toEqual({ PATH: '/usr/bin' });
  });
});

describe('bounded shell output', () => {
  it('preserves the beginning and true tail with an exact byte omission count', () => {
    const source = `BEGIN-${'🙂'.repeat(150)}-TRUE-END`;
    const output = boundUtf8Output(source, 180);
    const marker = output.match(
      /\n\[truncated: (\d+) bytes omitted; preserved beginning and true tail\]\n/,
    );

    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(180);
    expect(output).toContain('BEGIN-');
    expect(output).toContain('-TRUE-END');
    expect(output).not.toContain('�');
    expect(marker).not.toBeNull();

    const retained = output.replace(marker![0], '');
    expect(Number(marker![1])).toBe(
      Buffer.byteLength(source, 'utf-8') - Buffer.byteLength(retained, 'utf-8'),
    );
  });

  it('LocalShellAdapter keeps the real final stdout/stderr emitted after the cap', async () => {
    const adapter = new LocalShellAdapter();
    const script = [
      `process.stdout.write('OUT-BEGIN-' + 'o'.repeat(2000) + '-OUT-TRUE-END');`,
      `process.stderr.write('ERR-BEGIN-' + 'e'.repeat(2000) + '-ERR-TRUE-END');`,
    ].join('');
    const result = await adapter.spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 256,
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(256);
    expect(result.stdout).toContain('OUT-BEGIN-');
    expect(result.stdout).toContain('-OUT-TRUE-END');
    expect(result.stderr).toContain('ERR-BEGIN-');
    expect(result.stderr).toContain('-ERR-TRUE-END');
    expect(result.stdout).toMatch(/\[truncated: \d+ bytes omitted;/);
    expect(result.stderr).toMatch(/\[truncated: \d+ bytes omitted;/);
    expect(result.stdoutTruncation).toEqual(expect.objectContaining({ outputBytes: 256 }));
    expect(result.stderrTruncation).toEqual(expect.objectContaining({ outputBytes: 256 }));
    expect(result.stdoutTruncation!.inputBytes).toBeGreaterThan(result.stdoutTruncation!.outputBytes);
    expect(result.stderrTruncation!.inputBytes).toBeGreaterThan(result.stderrTruncation!.outputBytes);
  });
});
