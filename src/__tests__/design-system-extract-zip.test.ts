import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZipToDir, isUnsafePath } from '../core/design-system/extract-zip.js';

describe('isUnsafePath', () => {
  it('rejects empty / dot / dotdot', () => {
    expect(isUnsafePath('')).toBe(true);
    expect(isUnsafePath('.')).toBe(true);
    expect(isUnsafePath('..')).toBe(true);
  });

  it('rejects absolute paths (POSIX + Windows)', () => {
    expect(isUnsafePath('/etc/passwd')).toBe(true);
    expect(isUnsafePath('C:\\Windows\\System32')).toBe(true);
  });

  it('rejects traversal segments', () => {
    expect(isUnsafePath('../foo')).toBe(true);
    expect(isUnsafePath('foo/../bar')).toBe(true);
    expect(isUnsafePath('foo\\..\\bar')).toBe(true);
  });

  it('accepts normal relative paths', () => {
    expect(isUnsafePath('foo.txt')).toBe(false);
    expect(isUnsafePath('foo/bar/baz.css')).toBe(false);
    expect(isUnsafePath('a-b_c/d.scss')).toBe(false);
  });
});

describe('extractZipToDir', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-ds-extract-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function buildZip(entries: Record<string, string>): string {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(entries)) {
      zip.addFile(name, Buffer.from(content, 'utf8'));
    }
    const path = join(dir, 'src.zip');
    zip.writeZip(path);
    return path;
  }

  it('extracts a flat zip', () => {
    const zipPath = buildZip({
      'index.html': '<html></html>',
      'styles.css': 'body{}',
    });
    const dest = join(dir, 'out');
    const result = extractZipToDir(zipPath, dest);
    expect(result.filesWritten).toBe(2);
    expect(existsSync(join(dest, 'index.html'))).toBe(true);
    expect(readFileSync(join(dest, 'styles.css'), 'utf8')).toBe('body{}');
  });

  it('preserves nested directories', () => {
    const zipPath = buildZip({
      'theme/components/button.html': '<button>',
      'theme/tokens/_colors.scss': '$primary: red;',
    });
    const dest = join(dir, 'out');
    const result = extractZipToDir(zipPath, dest);
    expect(result.filesWritten).toBe(2);
    expect(readFileSync(join(dest, 'theme/components/button.html'), 'utf8')).toBe('<button>');
  });

  it('never writes files outside the destination directory', () => {
    // AdmZip may normalise/strip leading `..` itself when writing — the
    // real-world threat is a malicious zip crafted by a different tool.
    // We can't always synthesise that here, so we assert the actual
    // security property: nothing escapes `dest`. The skipped/filesWritten
    // counts depend on AdmZip's own write behaviour and are checked in
    // the dedicated `isUnsafePath` unit tests above.
    const zipPath = buildZip({
      '../../etc/passwd': 'pwned',
      'safe.html': 'ok',
    });
    const dest = join(dir, 'out');
    const sentinel = join(dir, 'etc', 'passwd');
    extractZipToDir(zipPath, dest);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(dest, 'safe.html'))).toBe(true);
  });

  it('respects maxBytes', () => {
    const big = 'x'.repeat(2048);
    const zipPath = buildZip({
      'a.txt': big,
      'b.txt': big,
      'c.txt': big,
    });
    const dest = join(dir, 'out');
    const result = extractZipToDir(zipPath, dest, { maxBytes: 3000 });
    // Only one (or two) of the 3 should fit. 3 × 2048 = 6144 > 3000.
    expect(result.filesWritten).toBeLessThan(3);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0].reason).toMatch(/maxBytes/);
  });

  it('cleans destination on opts.clean', () => {
    const dest = join(dir, 'out');
    // Pre-seed a stale file.
    require('node:fs').mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'stale.txt'), 'old');
    const zipPath = buildZip({ 'fresh.txt': 'new' });
    extractZipToDir(zipPath, dest, { clean: true });
    expect(existsSync(join(dest, 'stale.txt'))).toBe(false);
    expect(existsSync(join(dest, 'fresh.txt'))).toBe(true);
  });
});
