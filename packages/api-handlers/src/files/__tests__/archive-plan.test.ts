/**
 * Regression — two real holes in the old inline zip handlers:
 *
 * 1. `archive` had NO size guard whatsoever. adm-zip reads every member into
 *    memory and deflates the archive into a single Buffer, so a big enough
 *    selection was an OOM crash of the whole Electron main process.
 *
 * 2. `extract` had a 500 MB cap that ran AFTER `entry.getData()` — a full
 *    synchronous inflate into a Buffer. A 100 KB entry declaring 10 GB
 *    uncompressed blew the heap before the counter could fire, so the cap did
 *    not defend against the zip bomb it looked like it defended against.
 *
 * Sizes now come from the central directory and are budgeted before anything is
 * inflated. Pure module, so none of this needs a filesystem.
 */
import { describe, expect, it } from 'vitest';
import {
  ArchiveLimitError,
  DEFAULT_ARCHIVE_LIMITS,
  checkArchiveBudget,
  planExtract,
  safeEntryName,
} from '../archive-plan.js';

const member = (entryName: string, size: number, compressedSize?: number) => ({ entryName, size, compressedSize });
const zipEntry = (entryName: string, size: number, compressedSize = size, isDirectory = false) => ({
  entryName,
  isDirectory,
  size,
  compressedSize,
});

describe('archive budget', () => {
  it('accepts an ordinary set and reports totals for the progress bar', () => {
    expect(checkArchiveBudget([member('a.txt', 100), member('b/c.txt', 250)])).toEqual({ files: 2, bytes: 350 });
  });

  it('refuses a total that exceeds the cap — archive had NO cap before', () => {
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 1000 };
    expect(() => checkArchiveBudget([member('a', 600), member('b', 600)], limits)).toThrow(ArchiveLimitError);
    try {
      checkArchiveBudget([member('a', 600), member('b', 600)], limits);
    } catch (e) {
      expect((e as ArchiveLimitError).code).toBe('archive_too_large');
    }
  });

  it('refuses a single oversized member', () => {
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxEntryBytes: 500 };
    expect(() => checkArchiveBudget([member('huge.bin', 501)], limits)).toThrow(/per-file limit/);
  });

  it('refuses an absurd entry count before walking it', () => {
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 };
    expect(() => checkArchiveBudget([member('a', 1), member('b', 1), member('c', 1)], limits)).toThrow(/entries/);
  });

  it('refuses an implausible compression ratio (the zip bomb), on DECLARED sizes', () => {
    // 100 KB compressed claiming 1 GB uncompressed = 10000×. Under the 2 GB
    // per-entry cap, so the RATIO rule is what has to catch this one — refused
    // while it is still just a number in the central directory, no inflate.
    const bomb = member('bomb', 1_000_000_000, 100_000);
    expect(() => checkArchiveBudget([bomb])).toThrow(ArchiveLimitError);
    try {
      checkArchiveBudget([bomb]);
    } catch (e) {
      expect((e as ArchiveLimitError).code).toBe('archive_suspicious_ratio');
    }
  });

  it('a bomb too large for the per-entry cap is still refused (by size, not ratio)', () => {
    // Belt and braces: either guard firing is fine, what matters is that no
    // path reaches an inflate.
    try {
      checkArchiveBudget([member('bomb', 10_000_000_000, 100_000)]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ArchiveLimitError).code).toBe('archive_entry_too_large');
    }
  });

  it('allows a normal, well-compressing text file', () => {
    // ~50× is routine for logs/JSON and must not trip the ratio guard.
    expect(() => checkArchiveBudget([member('app.log', 5_000_000, 100_000)])).not.toThrow();
  });

  it('ignores the ratio rule when the compressed size is unknown or zero', () => {
    expect(() => checkArchiveBudget([member('a', 1_000_000)])).not.toThrow();
    expect(() => checkArchiveBudget([member('empty', 0, 0)])).not.toThrow();
  });
});

describe('archive member names', () => {
  it('normalizes ordinary relative names', () => {
    expect(safeEntryName('a/b/c.txt')).toBe('a/b/c.txt');
    expect(safeEntryName('./a/./b.txt')).toBe('a/b.txt');
  });

  it('folds Windows separators BEFORE checking traversal', () => {
    // A `..\` segment must not slip past a check that only looked for `../`.
    expect(safeEntryName('..\\..\\Windows\\System32\\evil.dll')).toBeNull();
    expect(safeEntryName('a\\b\\c.txt')).toBe('a/b/c.txt');
  });

  it('refuses traversal, absolute paths and drive/UNC prefixes', () => {
    expect(safeEntryName('../../etc/passwd')).toBeNull();
    expect(safeEntryName('a/../../b')).toBeNull();
    expect(safeEntryName('/etc/passwd')).toBeNull();
    expect(safeEntryName('C:/Windows/evil.dll')).toBeNull();
    expect(safeEntryName('\\\\server\\share\\evil')).toBeNull();
    expect(safeEntryName('')).toBeNull();
    expect(safeEntryName('.')).toBeNull();
  });
});

describe('planExtract', () => {
  it('skips directories and returns file members with safe names', () => {
    const { members, budget } = planExtract([
      zipEntry('top/', 0, 0, true),
      zipEntry('top/a.txt', 10),
      zipEntry('top\\b.txt', 20),
    ]);
    expect(members.map((m) => m.safeName)).toEqual(['top/a.txt', 'top/b.txt']);
    expect(budget).toEqual({ files: 2, bytes: 30 });
  });

  it('FAILS the whole archive on a traversing member — never half-extracts', () => {
    expect(() => planExtract([zipEntry('ok.txt', 10), zipEntry('../../evil', 10)])).toThrow(ArchiveLimitError);
    try {
      planExtract([zipEntry('../../evil', 10)]);
    } catch (e) {
      expect((e as ArchiveLimitError).code).toBe('archive_path_escape');
    }
  });

  it('rejects a zip bomb from its declared header, with nothing inflated', () => {
    expect(() => planExtract([zipEntry('bomb.bin', 1_000_000_000, 100_000)])).toThrow(/ratio/);
  });
});
