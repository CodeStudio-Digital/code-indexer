/**
 * mergeRuntimeEnvs — pure merge of per-project runtime envs for a GLOBAL
 * (synthetic union) session. The caller passes envs PRIMARY FIRST; this proves
 * primary PATH precedence + dedupe and first-writer-wins for extraEnv.
 */
import { describe, expect, it } from 'vitest';
import { mergeRuntimeEnvs } from '../runtime-resolve.js';

describe('mergeRuntimeEnvs', () => {
  it('empty union → empty env', () => {
    expect(mergeRuntimeEnvs([])).toEqual({ pathPrepend: [], extraEnv: {} });
  });

  it('single project → passthrough', () => {
    const env = { pathPrepend: ['/php81/bin'], extraEnv: { PHPRC: '/php81/bin' } };
    expect(mergeRuntimeEnvs([env])).toEqual(env);
  });

  it('primary first wins PATH order and dedupes shared dirs', () => {
    const merged = mergeRuntimeEnvs([
      { pathPrepend: ['/php81/bin'], extraEnv: {} },               // primary (PHP)
      { pathPrepend: ['/py312/bin', '/php81/bin'], extraEnv: {} }, // secondary (Python, + same PHP)
    ]);
    expect(merged.pathPrepend).toEqual(['/php81/bin', '/py312/bin']); // /php81 not duplicated
  });

  it('conflicting extraEnv keeps the primary value (only one runtime can be active)', () => {
    const merged = mergeRuntimeEnvs([
      { pathPrepend: ['/php81/bin'], extraEnv: { PHPRC: '/php81/bin' } }, // primary picks 8.1
      { pathPrepend: ['/php83/bin'], extraEnv: { PHPRC: '/php83/bin' } }, // secondary picks 8.3
    ]);
    expect(merged.pathPrepend).toEqual(['/php81/bin', '/php83/bin']);
    expect(merged.extraEnv.PHPRC).toBe('/php81/bin'); // primary wins
  });

  it('unions distinct env vars from every project', () => {
    const merged = mergeRuntimeEnvs([
      { pathPrepend: [], extraEnv: { PHPRC: '/php/bin' } },
      { pathPrepend: [], extraEnv: { PYTHONHOME: '/py' } },
    ]);
    expect(merged.extraEnv).toEqual({ PHPRC: '/php/bin', PYTHONHOME: '/py' });
  });
});
