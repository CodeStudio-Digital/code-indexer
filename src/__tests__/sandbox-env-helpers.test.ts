import { describe, it, expect, afterEach, vi } from 'vitest';
import { join, resolve } from 'node:path';
import {
  parseDotEnv,
  renderDotEnv,
  resolveHostWorkdirMount,
  resolveSessionEnvs,
} from '@mcp/services/sandbox/manager/io/env-helpers.js';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';

// ─── parseDotEnv ────────────────────────────────────────────────

describe('parseDotEnv', () => {
  it('parses simple KEY=VALUE lines', () => {
    expect(parseDotEnv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns an empty record for empty input', () => {
    expect(parseDotEnv('')).toEqual({});
  });

  it('skips blank lines and comments', () => {
    const out = parseDotEnv('# A comment\n\nFOO=bar\n  \n# another\nBAZ=qux');
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips lines without an `=` sign', () => {
    expect(parseDotEnv('NOEQUALS\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('strips a single matching pair of double quotes', () => {
    expect(parseDotEnv('FOO="hello world"')).toEqual({ FOO: 'hello world' });
  });

  it('strips a single matching pair of single quotes', () => {
    expect(parseDotEnv("FOO='hello world'")).toEqual({ FOO: 'hello world' });
  });

  it('does not strip mismatched quotes', () => {
    expect(parseDotEnv(`FOO="hello'`)).toEqual({ FOO: `"hello'` });
  });

  it('strips inline comments only on unquoted values', () => {
    expect(parseDotEnv('FOO=bar # comment')).toEqual({ FOO: 'bar' });
  });

  it('keeps `#` inside quoted values', () => {
    expect(parseDotEnv('FOO="bar # not a comment"')).toEqual({ FOO: 'bar # not a comment' });
  });

  it('rejects keys that do not look like env var names', () => {
    expect(parseDotEnv('123=invalid\nFOO=ok')).toEqual({ FOO: 'ok' });
    expect(parseDotEnv('with-dash=invalid\nFOO=ok')).toEqual({ FOO: 'ok' });
  });

  it('accepts keys starting with underscore', () => {
    expect(parseDotEnv('_PRIVATE=hidden')).toEqual({ _PRIVATE: 'hidden' });
  });

  it('trims whitespace around keys and values', () => {
    expect(parseDotEnv('  FOO  =  bar  ')).toEqual({ FOO: 'bar' });
  });

  it('handles CRLF line endings', () => {
    expect(parseDotEnv('FOO=bar\r\nBAZ=qux\r\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});

// ─── renderDotEnv ───────────────────────────────────────────────

describe('renderDotEnv', () => {
  it('emits the managed-by header even for an empty map', () => {
    const out = renderDotEnv({});
    expect(out).toMatch(/Managed by MCP SandboxService/);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('emits one line per key for simple values', () => {
    const out = renderDotEnv({ FOO: 'bar', BAZ: 'qux' });
    expect(out).toContain('FOO=bar');
    expect(out).toContain('BAZ=qux');
  });

  it('quotes values containing whitespace', () => {
    const out = renderDotEnv({ MSG: 'hello world' });
    expect(out).toContain('MSG="hello world"');
  });

  it('quotes empty values', () => {
    const out = renderDotEnv({ EMPTY: '' });
    expect(out).toContain('EMPTY=""');
  });

  it('escapes embedded double quotes inside quoted values', () => {
    const out = renderDotEnv({ MSG: 'say "hi"' });
    expect(out).toContain('MSG="say \\"hi\\""');
  });

  it('escapes backslashes inside quoted values', () => {
    const out = renderDotEnv({ PATH: 'a\\b' });
    expect(out).toContain('PATH="a\\\\b"');
  });

  it('escapes $ inside quoted values so the shell does not expand', () => {
    const out = renderDotEnv({ FOO: '$BAR' });
    expect(out).toContain('FOO="\\$BAR"');
  });

  it('skips keys that are not valid env var names', () => {
    const out = renderDotEnv({ 'bad-key': 'x', GOOD: 'y' } as Record<string, string>);
    expect(out).not.toContain('bad-key');
    expect(out).toContain('GOOD=y');
  });

  it('round-trips through parseDotEnv', () => {
    const original = { FOO: 'bar', MSG: 'hello world', EMPTY: '' };
    const rendered = renderDotEnv(original);
    const reparsed = parseDotEnv(rendered);
    expect(reparsed).toEqual(original);
  });
});

// ─── resolveHostWorkdirMount ────────────────────────────────────

describe('resolveHostWorkdirMount', () => {
  const originalBindMount = process.env.MCP_SANDBOX_BIND_MOUNT;
  const originalHostDir = process.env.MCP_SANDBOX_WORKDIR_HOST_DIR;

  afterEach(() => {
    if (originalBindMount === undefined) delete process.env.MCP_SANDBOX_BIND_MOUNT;
    else process.env.MCP_SANDBOX_BIND_MOUNT = originalBindMount;
    if (originalHostDir === undefined) delete process.env.MCP_SANDBOX_WORKDIR_HOST_DIR;
    else process.env.MCP_SANDBOX_WORKDIR_HOST_DIR = originalHostDir;
  });

  it('returns a path under <mcpDataDir>/virtual-projects by default', () => {
    delete process.env.MCP_SANDBOX_BIND_MOUNT;
    delete process.env.MCP_SANDBOX_WORKDIR_HOST_DIR;
    const out = resolveHostWorkdirMount('42');
    expect(out).not.toBeNull();
    // No longer under the project-root `data/` — lives in the user data dir.
    expect(out!.startsWith(mcpDataDir())).toBe(true);
    expect(out!.replace(/\\/g, '/')).toMatch(/virtual-projects\/42$/);
  });

  it('returns null when MCP_SANDBOX_BIND_MOUNT=0', () => {
    process.env.MCP_SANDBOX_BIND_MOUNT = '0';
    expect(resolveHostWorkdirMount('42')).toBeNull();
  });

  it('honours MCP_SANDBOX_WORKDIR_HOST_DIR override', () => {
    delete process.env.MCP_SANDBOX_BIND_MOUNT;
    // Override is resolved to an absolute path (bind-mounts must be absolute).
    const override = process.platform === 'win32' ? 'D:\\custom\\sandbox-roots' : '/custom/sandbox-roots';
    process.env.MCP_SANDBOX_WORKDIR_HOST_DIR = override;
    const out = resolveHostWorkdirMount('42');
    expect(out).toBe(join(resolve(override), '42'));
  });
});

// ─── resolveSessionEnvs ─────────────────────────────────────────

describe('resolveSessionEnvs', () => {
  it('returns empty record when store is null', () => {
    expect(resolveSessionEnvs(null, '42')).toEqual({});
  });

  it('returns empty record when sessionId is not numeric', () => {
    const store = {
      asRecord: vi.fn().mockReturnValue({ FOO: 'bar' }),
    } as unknown as CompanySessionEnvStore;
    expect(resolveSessionEnvs(store, 'not-a-number')).toEqual({});
    expect((store.asRecord as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('calls asRecord with the parsed numeric id', () => {
    const asRecord = vi.fn().mockReturnValue({ FOO: 'bar' });
    const store = { asRecord } as unknown as CompanySessionEnvStore;
    expect(resolveSessionEnvs(store, '42')).toEqual({ FOO: 'bar' });
    expect(asRecord).toHaveBeenCalledWith(42);
  });

  it('returns empty record when asRecord throws', () => {
    const store = {
      asRecord: vi.fn(() => {
        throw new Error('db unreachable');
      }),
    } as unknown as CompanySessionEnvStore;
    expect(resolveSessionEnvs(store, '42')).toEqual({});
  });
});
