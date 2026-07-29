import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  nodeModulesVolumeFor,
  projectImageTag,
  sessionNetworkName,
  resolveRuntimeBinary,
} from '@mcp/services/sandbox/manager/util/naming.js';
import {
  ensureSafeRelPath,
  absolutize,
} from '@mcp/services/sandbox/manager/util/paths.js';
import { shQuote, truncateForLog } from '@mcp/services/sandbox/manager/util/shell.js';
import {
  resolvePublicBase,
  defaultPreviewUrl,
  previewPathPrefixOf,
} from '@mcp/services/sandbox/manager/util/preview-url.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000042';
const UPPERCASE_SESSION_ID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

// ─── naming.ts ──────────────────────────────────────────────────

describe('nodeModulesVolumeFor', () => {
  it('prefixes a canonical session UUID with mcp-sbx-nm-', () => {
    expect(nodeModulesVolumeFor(SESSION_ID)).toBe(`mcp-sbx-nm-${SESSION_ID}`);
  });

  it('normalizes UUID case', () => {
    expect(nodeModulesVolumeFor(UPPERCASE_SESSION_ID)).toBe(
      `mcp-sbx-nm-${UPPERCASE_SESSION_ID.toLowerCase()}`,
    );
  });

  it('rejects malformed and numeric session ids', () => {
    expect(() => nodeModulesVolumeFor('42')).toThrow(/canonical UUID/);
    expect(() => nodeModulesVolumeFor(42 as unknown as string)).toThrow(/canonical UUID/);
  });
});

describe('projectImageTag', () => {
  it('builds a :latest tag with the default "main" service id', () => {
    expect(projectImageTag(SESSION_ID)).toBe(`mcp-session-${SESSION_ID}-main:latest`);
  });

  it('uses the provided service id when given', () => {
    expect(projectImageTag(SESSION_ID, 'api')).toBe(`mcp-session-${SESSION_ID}-api:latest`);
  });

  it('sanitises the service id without weakening the session UUID boundary', () => {
    expect(projectImageTag(SESSION_ID, 'foo:bar')).toBe(
      `mcp-session-${SESSION_ID}-foo-bar:latest`,
    );
  });

  it('truncates service id to 32 chars', () => {
    const longService = 'y'.repeat(100);
    const out = projectImageTag(SESSION_ID, longService);
    expect(out).toBe(`mcp-session-${SESSION_ID}-${'y'.repeat(32)}:latest`);
  });

  it('rejects a legacy numeric session id', () => {
    expect(() => projectImageTag(42 as unknown as string)).toThrow(/canonical UUID/);
  });
});

describe('sessionNetworkName', () => {
  it('prefixes with mcp-sbx-net-', () => {
    expect(sessionNetworkName(SESSION_ID)).toBe(`mcp-sbx-net-${SESSION_ID}`);
  });

  it('rejects malformed and numeric session ids', () => {
    expect(() => sessionNetworkName('a/b')).toThrow(/canonical UUID/);
    expect(() => sessionNetworkName(42 as unknown as string)).toThrow(/canonical UUID/);
  });
});

describe('resolveRuntimeBinary', () => {
  const originalEnv = process.env.MCP_SANDBOX_RUNTIME;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MCP_SANDBOX_RUNTIME;
    else process.env.MCP_SANDBOX_RUNTIME = originalEnv;
  });

  it('defaults to docker when env var is unset', () => {
    delete process.env.MCP_SANDBOX_RUNTIME;
    expect(resolveRuntimeBinary()).toBe('docker');
  });

  it('returns podman when MCP_SANDBOX_RUNTIME=podman', () => {
    process.env.MCP_SANDBOX_RUNTIME = 'podman';
    expect(resolveRuntimeBinary()).toBe('podman');
  });

  it('falls back to docker for any other value', () => {
    process.env.MCP_SANDBOX_RUNTIME = 'something-else';
    expect(resolveRuntimeBinary()).toBe('docker');
  });
});

// ─── paths.ts ───────────────────────────────────────────────────

describe('ensureSafeRelPath', () => {
  it('returns a normal path unchanged', () => {
    expect(ensureSafeRelPath('src/app.ts')).toBe('src/app.ts');
  });

  it('converts Windows backslashes to forward slashes', () => {
    expect(ensureSafeRelPath('src\\app.ts')).toBe('src/app.ts');
  });

  it('strips leading slashes after normalisation', () => {
    expect(ensureSafeRelPath('/src/app.ts')).toBe('src/app.ts');
  });

  it('rejects empty strings', () => {
    expect(() => ensureSafeRelPath('')).toThrow(/non-empty string/);
    expect(() => ensureSafeRelPath('   ')).toThrow(/non-empty string/);
  });

  it('rejects non-string inputs', () => {
    expect(() => ensureSafeRelPath(undefined as unknown as string)).toThrow(/non-empty string/);
    expect(() => ensureSafeRelPath(null as unknown as string)).toThrow(/non-empty string/);
  });

  it('rejects any `..` segment', () => {
    expect(() => ensureSafeRelPath('../etc/passwd')).toThrow(/\.\./);
    expect(() => ensureSafeRelPath('src/../etc/passwd')).toThrow(/\.\./);
    expect(() => ensureSafeRelPath('src/..')).toThrow(/\.\./);
  });

  it('rejects any `.` segment', () => {
    expect(() => ensureSafeRelPath('./foo')).toThrow(/\.\./);
    expect(() => ensureSafeRelPath('foo/./bar')).toThrow(/\.\./);
  });

  it('rejects NUL bytes', () => {
    expect(() => ensureSafeRelPath('src/\0/app.ts')).toThrow(/NUL byte/);
  });
});

describe('absolutize', () => {
  it('returns input as-is when relative is empty', () => {
    expect(absolutize('', 'https://example.com')).toBe('');
  });

  it('passes absolute URLs through unchanged', () => {
    expect(absolutize('https://other.com/x', 'https://example.com')).toBe('https://other.com/x');
    expect(absolutize('http://localhost:3000', 'https://example.com')).toBe(
      'http://localhost:3000',
    );
  });

  it('returns the relative path unchanged when base is null', () => {
    expect(absolutize('/preview/42/', null)).toBe('/preview/42/');
  });

  it('joins base + path when path is root-absolute', () => {
    expect(absolutize('/preview/42/', 'https://example.com')).toBe('https://example.com/preview/42/');
  });

  it('joins base + / + path when path is not root-absolute', () => {
    expect(absolutize('preview/42/', 'https://example.com')).toBe('https://example.com/preview/42/');
  });

  it('accepts custom schemes (s3://, ipfs://, etc.) as absolute', () => {
    expect(absolutize('s3://bucket/key', 'https://example.com')).toBe('s3://bucket/key');
  });
});

// ─── shell.ts ───────────────────────────────────────────────────

describe('shQuote', () => {
  it('returns alphanumeric strings unchanged (safe shell tokens)', () => {
    expect(shQuote('foo')).toBe('foo');
    expect(shQuote('foo-bar_baz.txt')).toBe('foo-bar_baz.txt');
    expect(shQuote('user@host:/path')).toBe('user@host:/path');
    expect(shQuote('KEY=value')).toBe('KEY=value');
  });

  it('wraps in single quotes when the input contains spaces', () => {
    expect(shQuote('hello world')).toBe(`'hello world'`);
  });

  it('wraps in single quotes when the input contains shell metacharacters', () => {
    expect(shQuote('$VAR')).toBe(`'$VAR'`);
    expect(shQuote('a; rm -rf /')).toBe(`'a; rm -rf /'`);
    expect(shQuote('a|b')).toBe(`'a|b'`);
  });

  it('escapes embedded single quotes via close-escape-reopen', () => {
    expect(shQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('handles the empty string by quoting it', () => {
    expect(shQuote('')).toBe(`''`);
  });
});

describe('truncateForLog', () => {
  it('returns short strings unchanged', () => {
    expect(truncateForLog('hello', 100)).toBe('hello');
  });

  it('truncates with byte-count suffix when over the limit', () => {
    expect(truncateForLog('hello world', 5)).toBe('hello …[+6 bytes]');
  });

  it('handles edge case where length equals max (no truncation)', () => {
    expect(truncateForLog('hello', 5)).toBe('hello');
  });
});

// ─── preview-url.ts ─────────────────────────────────────────────

describe('resolvePublicBase', () => {
  const originalPublic = process.env.MCP_PUBLIC_URL;
  const originalDashboard = process.env.MCP_DASHBOARD_URL;

  beforeEach(() => {
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.MCP_DASHBOARD_URL;
  });
  afterEach(() => {
    if (originalPublic === undefined) delete process.env.MCP_PUBLIC_URL;
    else process.env.MCP_PUBLIC_URL = originalPublic;
    if (originalDashboard === undefined) delete process.env.MCP_DASHBOARD_URL;
    else process.env.MCP_DASHBOARD_URL = originalDashboard;
  });

  it('returns null when neither env var is set', () => {
    expect(resolvePublicBase()).toBeNull();
  });

  it('returns null for an empty / whitespace value', () => {
    process.env.MCP_PUBLIC_URL = '   ';
    expect(resolvePublicBase()).toBeNull();
  });

  it('reads MCP_PUBLIC_URL when set', () => {
    process.env.MCP_PUBLIC_URL = 'https://app.example.com';
    expect(resolvePublicBase()).toBe('https://app.example.com');
  });

  it('falls back to MCP_DASHBOARD_URL when MCP_PUBLIC_URL is unset', () => {
    process.env.MCP_DASHBOARD_URL = 'https://dash.example.com';
    expect(resolvePublicBase()).toBe('https://dash.example.com');
  });

  it('prefers MCP_PUBLIC_URL over MCP_DASHBOARD_URL when both are set', () => {
    process.env.MCP_PUBLIC_URL = 'https://app.example.com';
    process.env.MCP_DASHBOARD_URL = 'https://dash.example.com';
    expect(resolvePublicBase()).toBe('https://app.example.com');
  });

  it('strips trailing slashes', () => {
    process.env.MCP_PUBLIC_URL = 'https://app.example.com///';
    expect(resolvePublicBase()).toBe('https://app.example.com');
  });
});

describe('defaultPreviewUrl', () => {
  it('builds a direct loopback URL pointing at the sandbox host port', () => {
    expect(defaultPreviewUrl(SESSION_ID, 34001)).toBe('http://127.0.0.1:34001/');
  });

  it('ignores the session id (Phase C: no proxy path)', () => {
    expect(defaultPreviewUrl('a/b', 34001)).toBe('http://127.0.0.1:34001/');
  });

  it('honors the host port', () => {
    expect(defaultPreviewUrl(SESSION_ID, 99999)).toBe('http://127.0.0.1:99999/');
  });
});

describe('previewPathPrefixOf', () => {
  it('returns relative paths with a trailing slash', () => {
    expect(previewPathPrefixOf('/preview/42/')).toBe('/preview/42/');
  });

  it('appends a trailing slash when missing', () => {
    expect(previewPathPrefixOf('/preview/42')).toBe('/preview/42/');
  });

  it('strips origin from absolute URLs', () => {
    expect(previewPathPrefixOf('https://app.example.com/preview/42/')).toBe('/preview/42/');
  });

  it('keeps the trailing slash on root-only URLs', () => {
    expect(previewPathPrefixOf('https://app.example.com')).toBe('/');
  });
});
