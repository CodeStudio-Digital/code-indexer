/**
 * mergeRuntimeEnvs — pure merge of per-project runtime envs for a GLOBAL
 * (synthetic union) session. The caller passes envs PRIMARY FIRST; this proves
 * primary PATH precedence + dedupe and first-writer-wins for extraEnv, across
 * BOTH the Windows (pathPrepend/extraEnv) and POSIX/WSL (posix*) channels.
 */
import { describe, expect, it } from 'vitest';
import { mergeRuntimeEnvs, type RuntimeEnv } from '../runtime-resolve.js';

/** Build a full RuntimeEnv from partials (defaults all four channels empty). */
function env(p: Partial<RuntimeEnv>): RuntimeEnv {
  return { pathPrepend: [], extraEnv: {}, posixPathPrepend: [], posixExtraEnv: {}, ...p };
}

describe('mergeRuntimeEnvs', () => {
  it('empty union → empty env', () => {
    expect(mergeRuntimeEnvs([])).toEqual(env({}));
  });

  it('single project → passthrough', () => {
    const e = env({ pathPrepend: ['/php81/bin'], extraEnv: { PHPRC: '/php81/bin' } });
    expect(mergeRuntimeEnvs([e])).toEqual(e);
  });

  it('primary first wins PATH order and dedupes shared dirs', () => {
    const merged = mergeRuntimeEnvs([
      env({ pathPrepend: ['/php81/bin'] }), // primary (PHP)
      env({ pathPrepend: ['/py312/bin', '/php81/bin'] }), // secondary (Python, + same PHP)
    ]);
    expect(merged.pathPrepend).toEqual(['/php81/bin', '/py312/bin']); // /php81 not duplicated
  });

  it('conflicting extraEnv keeps the primary value (only one runtime can be active)', () => {
    const merged = mergeRuntimeEnvs([
      env({ pathPrepend: ['/php81/bin'], extraEnv: { PHPRC: '/php81/bin' } }), // primary picks 8.1
      env({ pathPrepend: ['/php83/bin'], extraEnv: { PHPRC: '/php83/bin' } }), // secondary picks 8.3
    ]);
    expect(merged.pathPrepend).toEqual(['/php81/bin', '/php83/bin']);
    expect(merged.extraEnv.PHPRC).toBe('/php81/bin'); // primary wins
  });

  it('unions distinct env vars from every project', () => {
    const merged = mergeRuntimeEnvs([
      env({ extraEnv: { PHPRC: '/php/bin' } }),
      env({ extraEnv: { PYTHONHOME: '/py' } }),
    ]);
    expect(merged.extraEnv).toEqual({ PHPRC: '/php/bin', PYTHONHOME: '/py' });
  });

  it('merges the POSIX/WSL channel the same way (dedupe, primary-first)', () => {
    const merged = mergeRuntimeEnvs([
      env({ posixPathPrepend: ['$HOME/.mcp/runtimes/node/20.11.0/bin'] }),
      env({ posixPathPrepend: ['$HOME/.mcp/runtimes/python/3.12.3/bin', '$HOME/.mcp/runtimes/node/20.11.0/bin'] }),
    ]);
    expect(merged.posixPathPrepend).toEqual([
      '$HOME/.mcp/runtimes/node/20.11.0/bin',
      '$HOME/.mcp/runtimes/python/3.12.3/bin',
    ]);
    expect(merged.pathPrepend).toEqual([]); // WSL channel never leaks into the Windows one
  });
});
