/**
 * SnapshotRecordingFilesystemPort — decorator over `IFilesystemPort` that
 * captures a pre-write snapshot for every file the agent mutates. All
 * mutating tools (write_file, create_file, edit_file, multi_edit,
 * apply_patch) eventually call `writeFile` / `unlink` on this port, so a
 * single decorator covers them uniformly.
 *
 * Lifetime: one decorator instance per session — constructed alongside the
 * `ToolContext.ports.fs` at session bootstrap (see `runCoder` in
 * `src/core/coder/index.ts`).
 *
 * Important:
 *   - `runUnrecorded(fn)` exposes the raw inner port to callers that must
 *     bypass recording (e.g. the snapshot service when applying a revert
 *     — we don't want the revert itself to register as a new edit).
 *   - All non-mutating methods are pass-throughs.
 */
import type {
  FilesystemReaddirOptions,
  IFilesystemPort,
  PortDirent,
} from '@mcp/code-agent/ports/filesystem-port.js';
import { createHash } from 'node:crypto';
import {
  type CreateBaselineInput,
  type SessionKind,
  SessionFileSnapshotStore,
} from '@mcp/store/session-file-snapshot-store.js';

const MAX_BASELINE_BYTES = 4 * 1024 * 1024;

export interface SnapshotRecorderDeps {
  sessionKind: SessionKind;
  sessionId: number;
  projectRoot: string;
  store: SessionFileSnapshotStore;
  /** Returns the current turn number from the runner, or null when unknown. */
  getTurn?: () => number | null;
  /** Fired after a successful record so the SSE layer can notify clients. */
  onRecorded?: (info: { baselineId: number; filePath: string }) => void;
}

function toProjectRelative(absPath: string, projectRoot: string): string | null {
  const root = projectRoot.replace(/\\/g, '/');
  const p = absPath.replace(/\\/g, '/');
  if (!p.toLowerCase().startsWith(root.toLowerCase())) return null;
  let rel = p.slice(root.length);
  if (rel.startsWith('/')) rel = rel.slice(1);
  return rel || '.';
}

function hashContent(content: string | null): string {
  if (content == null) return '';
  const h = createHash('md5');
  // Normalize line endings so CRLF and LF map to the same baseline hash.
  h.update(content.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  return h.digest('hex');
}

function isBinaryLike(s: string): boolean {
  // Heuristic: presence of NUL → binary. We sample the prefix only to keep
  // this O(1) for huge strings (rare; we cap by size first anyway).
  const sample = s.length > 8192 ? s.slice(0, 8192) : s;
  return sample.indexOf(String.fromCharCode(0)) >= 0;
}

export class SnapshotRecorder {
  constructor(private readonly deps: SnapshotRecorderDeps) {}

  /**
   * Capture the pre-state of `absPath` (if any) and append an edit row.
   * Idempotent at the baseline level: subsequent calls for the same session+
   * file reuse the existing baseline, only appending to the edit log.
   *
   * `inner` is the raw filesystem port (no recording) — we use it to read
   * the file before the mutation happens.
   *
   * `expectedAfter` is the new content the caller is about to write (or
   * `null` for an unlink). We hash it for the edit row's audit field.
   */
  async record(
    absPath: string,
    inner: IFilesystemPort,
    info: { tool: string; expectedAfter: string | null; isDelete: boolean },
  ): Promise<void> {
    const relPath = toProjectRelative(absPath, this.deps.projectRoot);
    if (!relPath || relPath === '.') return; // out-of-project writes are not tracked.

    let existed = true;
    let content: string | null = null;
    try {
      content = await inner.readFile(absPath);
    } catch {
      existed = false;
      content = null;
    }

    const oversized = content != null && (content.length > MAX_BASELINE_BYTES || isBinaryLike(content));
    const baselineHash = hashContent(content);
    const create: CreateBaselineInput = {
      session_kind: this.deps.sessionKind,
      session_id: this.deps.sessionId,
      file_path: relPath.replace(/\\/g, '/'),
      content_before: oversized ? null : content,
      existed_before: existed,
      baseline_hash: baselineHash,
      oversized,
    };
    const afterHash = hashContent(info.expectedAfter);
    const { baseline } = this.deps.store.recordBaselineAndEdit(create, {
      turn_number: this.deps.getTurn?.() ?? null,
      tool_name: info.tool,
      content_after_hash: afterHash,
      was_delete: info.isDelete,
    });

    try {
      this.deps.onRecorded?.({ baselineId: baseline.id, filePath: create.file_path });
    } catch {
      // never let downstream notification errors propagate into the write path.
    }
  }
}

export class SnapshotRecordingFilesystemPort implements IFilesystemPort {
  constructor(
    private readonly inner: IFilesystemPort,
    private readonly recorder: SnapshotRecorder,
    /** Tag set by the caller so we can carry the most recent tool name into the audit row. */
    private currentToolName: string = 'write_file',
  ) {}

  /**
   * Tools that know their own name set it via this helper before issuing
   * the write. Optional — recorder falls back to 'write_file' otherwise.
   */
  setCurrentTool(name: string): void {
    this.currentToolName = name;
  }

  async writeFile(absPath: string, data: string): Promise<void> {
    await this.recorder.record(absPath, this.inner, {
      tool: this.currentToolName,
      expectedAfter: data,
      isDelete: false,
    });
    await this.inner.writeFile(absPath, data);
  }

  async unlink(absPath: string): Promise<void> {
    await this.recorder.record(absPath, this.inner, {
      tool: this.currentToolName,
      expectedAfter: null,
      isDelete: true,
    });
    await this.inner.unlink(absPath);
  }

  readFile(absPath: string): Promise<string> {
    return this.inner.readFile(absPath);
  }
  mkdir(absPath: string, options?: { recursive?: boolean }): Promise<void> {
    return this.inner.mkdir(absPath, options);
  }
  access(absPath: string): Promise<void> {
    return this.inner.access(absPath);
  }
  readdir(absPath: string, options: FilesystemReaddirOptions): Promise<PortDirent[]> {
    return this.inner.readdir(absPath, options);
  }

  /**
   * Escape hatch for the snapshot service: when applying a revert, we
   * mutate the disk via the raw port so the revert itself is NOT recorded
   * as a brand-new agent edit.
   */
  runUnrecorded<T>(fn: (raw: IFilesystemPort) => Promise<T>): Promise<T> {
    return fn(this.inner);
  }
}
