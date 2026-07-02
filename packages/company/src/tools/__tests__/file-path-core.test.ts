/**
 * Pure unit tests for the shared path/size rules (phase D2). These pin
 * the behavior both consumers rely on:
 *   - CompanyDriveStore.validatePath  → traversal 'segment', 4MB cap
 *   - docs-tools.resolveDocPath       → traversal 'substring', 256KB cap
 */
import { describe, expect, it } from 'vitest';
import {
  assertRelativePath,
  checkContentSize,
  checkRelativePath,
  DEFAULT_MAX_PATH_LENGTH,
  DOCS_CONTENT_CAP_BYTES,
  DOCS_MIRROR_PREFIX,
  DRIVE_WRITE_CAP_BYTES,
  isDocsMirrorPath,
} from '../file-path-core.js';

function msg(p: string, rules?: Parameters<typeof checkRelativePath>[1]): string | null {
  const res = checkRelativePath(p, rules);
  return res.ok ? null : res.message;
}

describe('checkRelativePath — common rules', () => {
  it('accepts ordinary nested paths with spaces, accents and parens', () => {
    for (const p of [
      'specs/auth.md',
      'Refatoração Angular Home/03 - Relatórios/x.md',
      'a (copy)/b+c.txt',
      'index.json',
    ]) {
      expect(checkRelativePath(p).ok).toBe(true);
      expect(checkRelativePath(p, { traversal: 'substring' }).ok).toBe(true);
    }
  });

  it('rejects empty paths', () => {
    expect(msg('')).toBe('path is required');
  });

  it('rejects over-long paths using the default 512 cap', () => {
    const long = 'a'.repeat(DEFAULT_MAX_PATH_LENGTH + 1);
    expect(msg(long)).toBe('path is too long (>512 chars)');
    expect(checkRelativePath('a'.repeat(DEFAULT_MAX_PATH_LENGTH)).ok).toBe(true);
  });

  it('honors a parameterized max length', () => {
    expect(msg('abcdef', { maxLength: 5 })).toBe('path is too long (>5 chars)');
  });

  it('rejects null bytes and control characters', () => {
    expect(msg('a\0b')).toBe('path must not contain null bytes');
    expect(msg('a\nb')).toBe('path must not contain control characters');
    expect(msg('a\tb')).toBe('path must not contain control characters');
  });

  it('rejects backslashes with the drive-compatible message', () => {
    expect(msg('a\\b.md')).toBe('path must use forward slashes ("/"), not backslashes');
  });

  it('rejects absolute paths', () => {
    expect(msg('/etc/passwd')).toBe('path must be relative (no leading "/")');
  });
});

describe('checkRelativePath — traversal modes', () => {
  it("segment mode rejects only exact '..' segments", () => {
    expect(msg('a/../b')).toBe('path must not contain ".." segments');
    expect(msg('..')).toBe('path must not contain ".." segments');
    // Names that merely CONTAIN dots stay legal (folder uploads).
    expect(checkRelativePath('..foo/bar.md').ok).toBe(true);
    expect(checkRelativePath('a..b/c.md').ok).toBe(true);
  });

  it("substring mode (docs) rejects any '..' occurrence", () => {
    const rules = { traversal: 'substring' as const };
    expect(msg('a/../b', rules)).toBe('path must not contain ".."');
    expect(msg('..foo/bar.md', rules)).toBe('path must not contain ".."');
    expect(msg('a..b/c.md', rules)).toBe('path must not contain ".."');
    expect(checkRelativePath('a.b/c.md', rules).ok).toBe(true);
  });
});

describe('assertRelativePath', () => {
  it('throws the message drive callers used to throw', () => {
    expect(() => assertRelativePath('/x')).toThrowError('path must be relative (no leading "/")');
    expect(() => assertRelativePath('ok/fine.md')).not.toThrow();
  });
});

describe('checkContentSize — parameterized caps', () => {
  it('enforces the docs cap (256KB)', () => {
    expect(checkContentSize(DOCS_CONTENT_CAP_BYTES, DOCS_CONTENT_CAP_BYTES).ok).toBe(true);
    const over = checkContentSize(DOCS_CONTENT_CAP_BYTES + 1, DOCS_CONTENT_CAP_BYTES);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain(`${DOCS_CONTENT_CAP_BYTES}`);
  });

  it('enforces the drive cap (4MB)', () => {
    expect(checkContentSize(DRIVE_WRITE_CAP_BYTES, DRIVE_WRITE_CAP_BYTES).ok).toBe(true);
    expect(checkContentSize(DRIVE_WRITE_CAP_BYTES + 1, DRIVE_WRITE_CAP_BYTES).ok).toBe(false);
  });
});

describe('docs mirror namespace', () => {
  it('detects the __docs__/ prefix', () => {
    expect(isDocsMirrorPath(`${DOCS_MIRROR_PREFIX}main/adr/0001.md`)).toBe(true);
    expect(isDocsMirrorPath('specs/auth.md')).toBe(false);
    // Only the exact prefix counts — a nested occurrence is a work path.
    expect(isDocsMirrorPath('nested/__docs__/x.md')).toBe(false);
  });
});
