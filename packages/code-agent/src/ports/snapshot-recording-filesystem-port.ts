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
  PortStats,
} from '@mcp/code-agent/ports/filesystem-port.js';
import {
  assertMutationFence,
} from '@mcp/code-agent/core/mutation-fence.js';
import type { ToolMutationFence } from '@mcp/code-agent/core/tool.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  type CreateBaselineInput,
  type SessionKind,
  type SessionSnapshotStorePort,
} from '@mcp/services/services/session-snapshot-port.js';
import { newSessionId, type SessionId } from '@mcp/session-storage';

const MAX_BASELINE_BYTES = 4 * 1024 * 1024;

export interface SnapshotRecorderDeps {
  sessionKind: SessionKind;
  sessionId: SessionId;
  /** Absolute root of the PRIMARY project (the native cwd). */
  projectRoot: string;
  /** Primary project id (migration 154). Stamped on baselines so revert/diff
   *  resolves the right root. Optional only to keep tests lightweight. */
  projectId?: number;
  /** Linked SECONDARY roots for a global session — writes under any of these are
   *  recorded against that root's project. Empty/undefined for normal sessions. */
  secondaryRoots?: ReadonlyArray<{ projectId: number; rootPath: string }>;
  store: SessionSnapshotStorePort<SessionId, string>;
  /** Returns the current turn number from the runner, or null when unknown. */
  getTurn?: () => number | null;
  /** Persisted user-message id delimiting the current conversational round. */
  getRoundMessageId?: () => number | null;
  /** Fired after a successful record so the SSE layer can notify clients. */
  onRecorded?: (info: {
    baselineId: string;
    globalBaselineId: string;
    roundMessageId: number | null;
    roundSnapshotId: string | null;
    filePath: string;
  }) => void;
}

export interface PreparedSnapshotMutation {
  globalBaselineId: string;
  operationId: string;
  roundMessageId: number | null;
  projectId: number | null;
  filePath: string;
  contentBefore: string | null;
  existedBefore: boolean;
  contentAfter: string | null;
  existedAfter: boolean;
  oversized: boolean;
}

function toProjectRelative(absPath: string, projectRoot: string): string | null {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(absPath);
  const rel = path.relative(root, candidate);
  if (
    rel === '..' ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  ) {
    return null;
  }
  return rel ? rel.replace(/\\/g, '/') : '.';
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
   * Resolve which known root (primary or a linked secondary) an absolute write
   * path falls under, via longest-prefix match, returning the owning project id
   * and the root-relative path. Returns null when the path is outside every
   * known root (those writes are not tracked, as before). For a normal session
   * there is only the primary root, so this is byte-equivalent to the old
   * single-root `toProjectRelative`.
   */
  private resolveRoot(absPath: string): { projectId: number | null; relPath: string } | null {
    const candidates: Array<{ projectId: number | null; rootPath: string }> = [
      { projectId: this.deps.projectId ?? null, rootPath: this.deps.projectRoot },
      ...(this.deps.secondaryRoots ?? []),
    ];
    let best: { projectId: number | null; relPath: string; rootLen: number } | null = null;
    for (const c of candidates) {
      const rel = toProjectRelative(absPath, c.rootPath);
      if (rel == null || rel === '.') continue;
      if (!best || c.rootPath.length > best.rootLen) {
        best = { projectId: c.projectId, relPath: rel, rootLen: c.rootPath.length };
      }
    }
    return best ? { projectId: best.projectId, relPath: best.relPath } : null;
  }

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
  ): Promise<PreparedSnapshotMutation | null> {
    const match = this.resolveRoot(absPath);
    if (!match) return null; // out of every known root — not tracked.
    const relPath = match.relPath;

    let existed = true;
    let content: string | null = null;
    try {
      content = await inner.readFile(absPath);
    } catch {
      existed = false;
      content = null;
    }

    const oversized = content != null && (content.length > MAX_BASELINE_BYTES || isBinaryLike(content));
    const afterOversized = info.expectedAfter != null
      && (info.expectedAfter.length > MAX_BASELINE_BYTES || isBinaryLike(info.expectedAfter));
    const baselineHash = hashContent(content);
    const operationId = `snapshot-mutation:${newSessionId()}`;
    const create: CreateBaselineInput<SessionId> = {
      session_kind: this.deps.sessionKind,
      session_id: this.deps.sessionId,
      project_id: match.projectId,
      file_path: relPath.replace(/\\/g, '/'),
      content_before: oversized ? null : content,
      rollback_content: content,
      existed_before: existed,
      baseline_hash: baselineHash,
      oversized: oversized || afterOversized,
      operation_id: operationId,
    };
    const afterHash = hashContent(info.expectedAfter);
    const { baseline } = await this.deps.store.recordBaselineAndEdit(create, {
      turn_number: this.deps.getTurn?.() ?? null,
      tool_name: info.tool,
      content_after_hash: afterHash,
      was_delete: info.isDelete,
      operation_id: operationId,
    });
    return {
      globalBaselineId: baseline.id,
      operationId,
      roundMessageId: this.deps.getRoundMessageId?.() ?? null,
      projectId: match.projectId,
      filePath: create.file_path,
      contentBefore: content,
      existedBefore: existed,
      contentAfter: info.expectedAfter,
      existedAfter: !info.isDelete,
      oversized: oversized || afterOversized,
    };
  }

  /** Commit the round envelope only after the filesystem mutation succeeded. */
  async complete(prepared: PreparedSnapshotMutation | null): Promise<void> {
    if (!prepared) return;
    let roundSnapshotId: string | null = null;
    if (prepared.roundMessageId != null) {
      const round = await this.deps.store.recordRoundSnapshotMutation({
        session_kind: this.deps.sessionKind,
        session_id: this.deps.sessionId,
        round_message_id: prepared.roundMessageId,
        global_baseline_id: prepared.globalBaselineId,
        project_id: prepared.projectId,
        file_path: prepared.filePath,
        content_before: prepared.contentBefore,
        existed_before: prepared.existedBefore,
        content_after: prepared.contentAfter,
        existed_after: prepared.existedAfter,
        oversized: prepared.oversized,
        operation_id: `${prepared.operationId}:round`,
      });
      roundSnapshotId = round.id;
    }
    try {
      this.deps.onRecorded?.({
        baselineId: prepared.globalBaselineId,
        globalBaselineId: prepared.globalBaselineId,
        roundMessageId: prepared.roundMessageId,
        roundSnapshotId,
        filePath: prepared.filePath,
      });
    } catch {
      // never let downstream notification errors propagate into the write path.
    }
  }
}

export class SnapshotRecordingFilesystemPort implements IFilesystemPort {
  private mutationFenceSource?: () => ToolMutationFence | undefined;

  constructor(
    private readonly inner: IFilesystemPort,
    private readonly recorder: SnapshotRecorder,
    /** Tag set by the caller so we can carry the most recent tool name into the audit row. */
    private currentToolName: string = 'write_file',
  ) {}

  get mutationFenceAttested(): true | undefined {
    return this.inner.mutationFenceAttested;
  }

  /**
   * Tools that know their own name set it via this helper before issuing
   * the write. Optional — recorder falls back to 'write_file' otherwise.
   */
  setCurrentTool(name: string): void {
    this.currentToolName = name;
  }

  setMutationFenceSource(source: () => ToolMutationFence | undefined): void {
    this.mutationFenceSource = source;
    this.inner.setMutationFenceSource?.(source);
  }

  async writeFile(absPath: string, data: string): Promise<void> {
    const prepared = await this.recorder.record(absPath, this.inner, {
      tool: this.currentToolName,
      expectedAfter: data,
      isDelete: false,
    });
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'writeFile',
      resource: absPath,
    });
    await this.inner.writeFile(absPath, data);
    await this.recorder.complete(prepared);
  }

  async unlink(absPath: string): Promise<void> {
    const prepared = await this.recorder.record(absPath, this.inner, {
      tool: this.currentToolName,
      expectedAfter: null,
      isDelete: true,
    });
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'unlink',
      resource: absPath,
    });
    await this.inner.unlink(absPath);
    await this.recorder.complete(prepared);
  }

  readFile(absPath: string): Promise<string> {
    return this.inner.readFile(absPath);
  }
  mkdir(absPath: string, options?: { recursive?: boolean }): Promise<void> {
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'mkdir',
      resource: absPath,
    });
    return this.inner.mkdir(absPath, options);
  }
  access(absPath: string): Promise<void> {
    return this.inner.access(absPath);
  }
  readdir(absPath: string, options: FilesystemReaddirOptions): Promise<PortDirent[]> {
    return this.inner.readdir(absPath, options);
  }
  stat(absPath: string): Promise<PortStats> {
    return this.inner.stat(absPath);
  }
  async rename(oldAbsPath: string, newAbsPath: string): Promise<void> {
    let expectedAfter: string | null = null;
    try {
      const st = await this.inner.stat(oldAbsPath);
      if (st.isFile()) expectedAfter = await this.inner.readFile(oldAbsPath);
    } catch {
      expectedAfter = null;
    }
    const oldPrepared = await this.recorder.record(oldAbsPath, this.inner, {
      tool: this.currentToolName,
      expectedAfter: null,
      isDelete: true,
    });
    const newPrepared = await this.recorder.record(newAbsPath, this.inner, {
      tool: this.currentToolName,
      expectedAfter,
      isDelete: false,
    });
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'rename',
      resource: oldAbsPath,
    });
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'rename',
      resource: newAbsPath,
    });
    await this.inner.rename(oldAbsPath, newAbsPath);
    await this.recorder.complete(oldPrepared);
    await this.recorder.complete(newPrepared);
  }
  async rm(absPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const prepared = await this.recorder.record(absPath, this.inner, {
      tool: this.currentToolName,
      expectedAfter: null,
      isDelete: true,
    });
    assertMutationFence(this.mutationFenceSource?.(), {
      kind: 'filesystem',
      operation: 'rm',
      resource: absPath,
    });
    await this.inner.rm(absPath, options);
    await this.recorder.complete(prepared);
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
