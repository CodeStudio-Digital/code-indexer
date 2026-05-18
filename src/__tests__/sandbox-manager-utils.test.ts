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

// ─── naming.ts ──────────────────────────────────────────────────

describe('nodeModulesVolumeFor', () => {
  it('prefixes with mcp-sbx-nm- and uses the raw id when already safe', () => {
    expect(nodeModulesVolumeFor('42')).toBe('mcp-sbx-nm-42');
  });

  it('keeps allowed alnum / underscore / dot / dash characters intact', () => {
    expect(nodeModulesVolumeFor('abc_123.test-x')).toBe('mcp-sbx-nm-abc_123.test-x');
  });

  it('replaces forbidden characters with dashes', () => {
    expect(nodeModulesVolumeFor('a/b c:d')).toBe('mcp-sbx-nm-a-b-c-d');
  });

  it('truncates session id to 48 chars', () => {
    const longId = 'x'.repeat(100);
    const out = nodeModulesVolumeFor(longId);
    expect(out).toBe('mcp-sbx-nm-' + 'x'.repeat(48));
  });

  it('handles numeric ids by string-coercing', () => {
    expect(nodeModulesVolumeFor(42 as unknown as string)).toBe('mcp-sbx-nm-42');
  });
});

describe('projectImageTag', () => {
  it('builds a :latest tag with the default "main" service id', () => {
    expect(projectImageTag('42')).toBe('mcp-session-42-main:latest');
  });

  it('uses the provided service id when given', () => {
    expect(projectImageTag('42', 'api')).toBe('mcp-session-42-api:latest');
  });

  it('sanitises both session and service id independently', () => {
    expect(projectImageTag('a/b', 'foo:bar')).toBe('mcp-session-a-b-foo-bar:latest');
  });

  it('truncates service id to 32 chars', () => {
    const longService = 'y'.repeat(100);
    const out = projectImageTag('1', longService);
    expect(out).toBe('mcp-session-1-' + 'y'.repeat(32) + ':latest');
  });
});

describe('sessionNetworkName', () => {
  it('prefixes with mcp-sbx-net-', () => {
    expect(sessionNetworkName('42')).toBe('mcp-sbx-net-42');
  });

  it('sanitises and truncates same as the volume name', () => {
    expect(sessionNetworkName('a/b')).toBe('mcp-sbx-net-a-b');
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
  it('builds the /preview/<id>/ relative URL', () => {
    expect(defaultPreviewUrl('42', 34001)).toBe('/preview/42/');
  });

  it('URL-encodes the session id', () => {
    expect(defaultPreviewUrl('a/b', 34001)).toBe('/preview/a%2Fb/');
  });

  it('ignores the host port (proxy doesn\'t need it in the URL)', () => {
    expect(defaultPreviewUrl('42', 99999)).toBe('/preview/42/');
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
