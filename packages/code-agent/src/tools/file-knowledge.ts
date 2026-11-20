import { createHash } from 'node:crypto';
import type { ToolContext, ToolResult } from '../core/tool.js';
import { err } from '../core/tool.js';
import type { IFilesystemPort } from '../ports/filesystem-port.js';

/**
 * What one runner knows about whole-file contents. A file is known when the
 * session read it with a file-read tool (any line range; a symbol-only read
 * does not count) or wrote the whole file itself. Each entry is a content
 * hash, so a change made on disk by anyone else turns it back into unknown
 * regardless of the filesystem port: none of them exposes mtime.
 *
 * A top-level session keeps one instance across its runs (sessionFileKnowledge);
 * any other runner gets a fresh one in the CoderRunner constructor. Subagents
 * get their own because their tool context never copies the parent's.
 */
export class SessionFileKnowledge {
  readonly #hashes = new Map<string, string>();

  /** The session saw (or wrote) this exact content. */
  recordContent(absPath: string, content: string): void {
    this.#hashes.set(knowledgeKey(absPath), contentHash(content));
  }

  /** The session's own partial edit: keep a known file known, never promote. */
  refreshIfKnown(absPath: string, content: string): void {
    const key = knowledgeKey(absPath);
    if (this.#hashes.has(key)) this.#hashes.set(key, contentHash(content));
  }

  forget(absPath: string): void {
    this.#hashes.delete(knowledgeKey(absPath));
  }

  /** The session moved a file: what it knew moves with the content. */
  moveIfKnown(fromPath: string, toPath: string, content: string): void {
    const known = this.#hashes.delete(knowledgeKey(fromPath));
    if (known) this.recordContent(toPath, content);
    else this.forget(toPath);
  }

  state(absPath: string, currentContent: string): 'known' | 'unknown' | 'changed' {
    const recorded = this.#hashes.get(knowledgeKey(absPath));
    if (recorded === undefined) return 'unknown';
    return recorded === contentHash(currentContent) ? 'known' : 'changed';
  }
}

// Each user message starts a new run of the same session; what the session
// read earlier must survive that. Hashes are re-verified at every overwrite,
// so a stale entry can only refuse, never permit, a write. Bounded LRU,
// process-local: a worker restart just means the session reads again.
const SESSION_KNOWLEDGE = new Map<string, SessionFileKnowledge>();
const MAX_SESSIONS = 64;

/** The knowledge of one top-level session, shared by all of its runs. */
export function sessionFileKnowledge(sessionId: string): SessionFileKnowledge {
  const existing = SESSION_KNOWLEDGE.get(sessionId);
  const knowledge = existing ?? new SessionFileKnowledge();
  SESSION_KNOWLEDGE.delete(sessionId);
  SESSION_KNOWLEDGE.set(sessionId, knowledge);
  while (SESSION_KNOWLEDGE.size > MAX_SESSIONS) {
    const oldest = SESSION_KNOWLEDGE.keys().next().value;
    if (oldest === undefined) break;
    SESSION_KNOWLEDGE.delete(oldest);
  }
  return knowledge;
}

function contentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/** Tools resolve both native and posix (sandbox) absolute paths; keep one key per file. */
export function knowledgeKey(absPath: string): string {
  const slashed = absPath.replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
}

export type OverwriteVerdict =
  | { allow: true; creating: boolean }
  | { allow: false; reason: 'unknown' | 'changed' | 'unverified' | 'no-registry' };

/**
 * The single overwrite rule (write_file, apply_patch `*** Add File:`): a
 * missing path is a creation; an existing file may be replaced only when the
 * session knows its current content.
 */
export async function overwriteVerdict(
  ctx: Pick<ToolContext, 'fileKnowledge'>,
  fs: IFilesystemPort,
  absPath: string,
): Promise<OverwriteVerdict> {
  try {
    await fs.access(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { allow: true, creating: true };
    return { allow: false, reason: 'unverified' };
  }
  let current: string;
  try {
    const stats = await fs.stat(absPath);
    if (!stats.isFile()) return { allow: true, creating: false }; // the write itself reports the type error
    current = await fs.readFile(absPath);
  } catch {
    return { allow: false, reason: 'unverified' };
  }
  if (!ctx.fileKnowledge) return { allow: false, reason: 'no-registry' };
  const state = ctx.fileKnowledge.state(absPath, current);
  return state === 'known' ? { allow: true, creating: false } : { allow: false, reason: state };
}

const REASONS: Record<Exclude<OverwriteVerdict, { allow: true }>['reason'], string> = {
  unknown: 'already exists and this session has not read it, so its current content is unknown',
  changed: 'changed on disk since this session last read or wrote it',
  unverified: 'exists but its current content could not be read to verify it',
  'no-registry': 'already exists and this run keeps no record of the files it read',
};

export function overwriteRefusal(
  tool: 'write_file' | 'apply_patch',
  displayPath: string,
  reason: Exclude<OverwriteVerdict, { allow: true }>['reason'],
): ToolResult {
  const next = tool === 'write_file'
    ? 'Read it with read_file, then repeat the call; for a targeted change use edit_file.'
    : `Read it with read_file and repeat the patch, or change it with "*** Update File: ${displayPath}".`;
  const subject = tool === 'write_file' ? `${displayPath}` : `Add File ${displayPath}`;
  const written = tool === 'write_file' ? 'Nothing was written.' : 'Nothing in this patch was written.';
  return {
    ...err(`${tool} refused: ${subject} ${REASONS[reason]}. ${written} ${next}`,
      { code: 'OVERWRITE_UNKNOWN_FILE', kind: 'refusal', retryable: false }),
    guardVerdict: {
      action: 'block', reason: `overwrite-${reason}`, refusalKind: 'overwrite-guard',
      shouldReflect: false, affectsFailureStreak: false, sourceTool: tool,
    },
  };
}
