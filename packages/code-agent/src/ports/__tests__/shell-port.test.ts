import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRuntimeEnv } from '../shell-port.js';

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
