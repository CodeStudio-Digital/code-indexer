/**
 * Budget + safety rules for archive/extract, kept pure so they can be tested
 * without touching a filesystem and reused identically on both sides of the
 * worker boundary.
 *
 * Two holes this closes:
 *
 * 1. `archive` had NO size guard at all. Zipping a folder read every file into
 *    memory and deflated the whole archive into one Buffer, so a large enough
 *    selection was an out-of-memory crash of the whole app.
 *
 * 2. `extract` had a 500 MB guard that ran in the WRONG ORDER: it called
 *    `entry.getData()` — a full synchronous inflate into a Buffer — and only
 *    THEN added the result to the counter. A 100 KB entry declaring 10 GB
 *    uncompressed blew the heap before the check could fire. The cap did not
 *    protect against the attack it appeared to protect against. Sizes now come
 *    from the central directory, before anything is inflated, and an absurd
 *    compression ratio is refused outright.
 */

export class ArchiveLimitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArchiveLimitError';
    this.code = code;
  }
}

export interface ArchiveLimits {
  /** Total uncompressed bytes across all members. */
  maxTotalBytes: number;
  /** Any single member. */
  maxEntryBytes: number;
  /** Number of members. */
  maxEntries: number;
  /**
   * Uncompressed ÷ compressed ceiling per entry. Real-world text tops out
   * around 100–200×; 1000× means a declared size no honest file produces.
   * Only applied when the compressed size is known (extract).
   */
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 200_000,
  maxCompressionRatio: 1000,
};

export interface PlannedMember {
  /** Path as it appears (or will appear) inside the archive, always posix. */
  entryName: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** Compressed size, when known (extract reads it from the central directory). */
  compressedSize?: number;
}

export interface ArchiveBudget {
  files: number;
  bytes: number;
}

/**
 * Enforce the budget over a set of members BEFORE any compression or inflation
 * happens. Throws `ArchiveLimitError`; returns the totals for progress reporting.
 */
export function checkArchiveBudget(members: PlannedMember[], limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveBudget {
  if (members.length > limits.maxEntries) {
    throw new ArchiveLimitError('archive_too_many_entries', `archive exceeds ${limits.maxEntries} entries`);
  }
  let bytes = 0;
  for (const m of members) {
    if (m.size > limits.maxEntryBytes) {
      throw new ArchiveLimitError('archive_entry_too_large', `entry exceeds the per-file limit: ${m.entryName}`);
    }
    // Ratio check runs per entry, on DECLARED sizes, so a zip bomb is refused
    // while it is still just a number in the central directory.
    if (m.compressedSize != null && m.compressedSize > 0 && m.size / m.compressedSize > limits.maxCompressionRatio) {
      throw new ArchiveLimitError('archive_suspicious_ratio', `entry has an implausible compression ratio: ${m.entryName}`);
    }
    bytes += m.size;
    if (bytes > limits.maxTotalBytes) {
      throw new ArchiveLimitError('archive_too_large', `archive content exceeds ${limits.maxTotalBytes} bytes`);
    }
  }
  return { files: members.length, bytes };
}

/**
 * Normalize an archive member name to a safe relative posix path, or null when
 * it would escape the destination.
 *
 * Refuses absolute paths (`/etc/passwd`), Windows drive/UNC prefixes
 * (`C:\…`, `\\server\share`), and any `..` segment. Backslashes are folded to
 * `/` first, because a zip written on Windows may use them and a `..\` segment
 * must not slip past a check that only looked for `../`.
 */
export function safeEntryName(raw: string): string | null {
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.length === 0) return null;
  if (normalized.startsWith('/')) return null; // absolute
  if (/^[a-zA-Z]:/.test(normalized)) return null; // C:\… drive-qualified
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..')) return null; // traversal
  return parts.join('/');
}

/**
 * Validate + budget the members of an archive about to be extracted. Entries
 * that would escape the destination are rejected outright (rather than skipped)
 * so a malicious archive fails loudly instead of half-extracting.
 */
export function planExtract(
  entries: Array<{ entryName: string; isDirectory: boolean; size: number; compressedSize?: number }>,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): { members: Array<PlannedMember & { safeName: string }>; budget: ArchiveBudget } {
  const members: Array<PlannedMember & { safeName: string }> = [];
  for (const e of entries) {
    const safeName = safeEntryName(e.entryName);
    if (safeName == null) {
      throw new ArchiveLimitError('archive_path_escape', `archive entry escapes the destination: ${e.entryName}`);
    }
    if (e.isDirectory) continue;
    members.push({ entryName: e.entryName, safeName, size: e.size, compressedSize: e.compressedSize });
  }
  return { members, budget: checkArchiveBudget(members, limits) };
}
