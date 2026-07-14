/**
 * SessionSnapshotService — business logic on top of SessionFileSnapshotStore.
 *
 * Responsibilities:
 *   - Compute live diff (baseline vs current disk) using snapshot-hunks.ts.
 *   - Surface hunk-level keep/undo state from session_file_hunk_decisions.
 *   - Mutate the disk for revert operations, bypassing the recording port
 *     so the revert itself isn't logged as a fresh edit.
 *   - Serialize concurrent operations on the same baseline (agent vs UI).
 *
 * The service is thin enough that the HTTP routes can call it directly;
 * we do not duplicate this logic on the dashboard side. The dashboard
 * receives ready-made hunks with stable fingerprints.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  type BaselineRow,
  type HunkDecisionRow,
  type SessionKind,
  SessionFileSnapshotStore,
} from '@mcp/store/session-file-snapshot-store.js';
import {
  applyHunkRevert,
  applyHunkRevertFlexible,
  computeHunks,
  type Hunk,
} from './snapshot-hunks.js';

export interface FileSummary {
  baselineId: number;
  filePath: string;
  status: BaselineRow['status'];
  existedBefore: boolean;
  oversized: boolean;
  firstSeenAt: string;
  lastEditedAt: string;
  closedAt: string | null;
  hunkCount: number;
  pendingHunks: number;
  addedLines: number;
  removedLines: number;
  /** True when the on-disk content matches the baseline (revert leaves no diff). */
  resolved: boolean;
}

export interface RoundFileSummary extends FileSummary {
  roundMessageId: number;
  roundSnapshotId: number;
  globalBaselineId: number;
  projectId: number | null;
}

export interface FileDiff {
  baseline: {
    id: number;
    filePath: string;
    existedBefore: boolean;
    oversized: boolean;
    status: BaselineRow['status'];
    /** Present for immutable per-round diffs; the full modal still uses `id`. */
    globalBaselineId?: number;
    roundMessageId?: number;
  };
  hunks: Array<Hunk & { decision: 'pending' | 'kept' | 'reverted' }>;
  /** True iff diff was suppressed because the baseline is oversized/binary. */
  diffDisabled: boolean;
  /** Current disk content (truncated to MAX bytes for transport). */
  currentContent: string | null;
}

const MAX_TRANSPORT_BYTES = 2 * 1024 * 1024;
const DEFAULT_DIFF_CONTEXT = 3;

/** Project-relative POSIX path → absolute platform path inside the project. */
function absoluteFor(projectRoot: string, relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  return path.resolve(projectRoot, ...parts);
}

async function readCurrentContent(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Treat "no readable regular file here" as missing content (null) rather
    // than throwing — a single bad path must not crash the whole snapshot
    // listing/diff. ENOENT: gone. EISDIR: the path is now a directory.
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw e;
  }
}

export class SessionSnapshotService {
  private readonly mutexes = new Map<number, Promise<unknown>>();
  private readonly roundMutexes = new Map<number, Promise<unknown>>();

  constructor(
    private readonly store: SessionFileSnapshotStore,
    // `projectId` (migration 154) lets a GLOBAL session's baselines resolve to
    // the right root (a baseline may belong to a linked secondary project). When
    // null the resolver falls back to the session's primary project, so normal
    // sessions are unaffected.
    private readonly resolveProjectRoot: (
      kind: SessionKind,
      sessionId: number,
      projectId?: number | null,
    ) => string | null,
  ) {}

  /**
   * List files altered in this session. Active baselines first, then closed
   * ones when `includeClosed` is set. The summary recomputes hunk count
   * (excluding kept/reverted decisions) so the UI sees an accurate "pending
   * review" badge.
   */
  async listFiles(
    kind: SessionKind,
    sessionId: number,
    opts: { includeClosed?: boolean } = {},
  ): Promise<FileSummary[]> {
    const baselines = this.store.listBaselines(kind, sessionId, opts);
    const summaries: FileSummary[] = [];
    for (const b of baselines) {
      // Resolve per baseline: a global session's files can live in different
      // roots, so the diff must read each from its own project.
      const projectRoot = this.resolveProjectRoot(kind, sessionId, b.project_id);
      let pendingHunks = 0;
      let hunkCount = 0;
      let addedLines = 0;
      let removedLines = 0;
      let resolved = false;
      if (b.status === 'active' && !b.oversized && projectRoot) {
        const abs = absoluteFor(projectRoot, b.file_path);
        const current = await readCurrentContent(abs);
        const hunks = computeHunks(b.content_before, current);
        hunkCount = hunks.length;
        const decisions = new Map(
          this.store
            .listHunkDecisions(b.id)
            .map((d: HunkDecisionRow) => [d.hunk_fingerprint, d.decision] as const),
        );
        for (const h of hunks) {
          const d = decisions.get(h.fingerprint);
          if (!d) {
            pendingHunks++;
            addedLines += h.addedCount;
            removedLines += h.removedCount;
          }
        }
        resolved = hunks.length === 0;
      }
      summaries.push({
        baselineId: b.id,
        filePath: b.file_path,
        status: b.status,
        existedBefore: !!b.existed_before,
        oversized: !!b.oversized,
        firstSeenAt: b.first_seen_at,
        lastEditedAt: b.last_edited_at,
        closedAt: b.closed_at,
        hunkCount,
        pendingHunks,
        addedLines,
        removedLines,
        resolved,
      });
    }
    return summaries;
  }

  async getDiff(
    baselineId: number,
    opts: { context?: number; contextBefore?: number; contextAfter?: number } = {},
  ): Promise<FileDiff | null> {
    const b = this.store.getBaselineById(baselineId);
    if (!b) return null;
    const projectRoot = this.resolveProjectRoot(b.session_kind, b.session_id, b.project_id);
    if (!projectRoot) return null;

    const decisions = new Map(
      this.store
        .listHunkDecisions(baselineId)
        .map((d: HunkDecisionRow) => [d.hunk_fingerprint, d.decision] as const),
    );

    if (b.oversized) {
      return {
        baseline: {
          id: b.id,
          filePath: b.file_path,
          existedBefore: !!b.existed_before,
          oversized: true,
          status: b.status,
        },
        hunks: [],
        diffDisabled: true,
        currentContent: null,
      };
    }

    const abs = absoluteFor(projectRoot, b.file_path);
    const current = await readCurrentContent(abs);
    const context = opts.context ?? DEFAULT_DIFF_CONTEXT;
    const hunks = computeHunks(b.content_before, current, {
      context,
      contextBefore: opts.contextBefore ?? context,
      contextAfter: opts.contextAfter ?? context,
    });
    const annotated = hunks.map((h) => ({
      ...h,
      decision: (decisions.get(h.fingerprint) ?? 'pending') as 'pending' | 'kept' | 'reverted',
    }));
    return {
      baseline: {
        id: b.id,
        filePath: b.file_path,
        existedBefore: !!b.existed_before,
        oversized: false,
        status: b.status,
      },
      hunks: annotated,
      diffDisabled: false,
      currentContent:
        current != null && current.length <= MAX_TRANSPORT_BYTES ? current : null,
    };
  }

  /** List the frozen file envelope for one persisted user-message round. */
  async listRoundFiles(
    kind: SessionKind,
    sessionId: number,
    roundMessageId: number,
  ): Promise<RoundFileSummary[]> {
    const rows = this.store.listRoundSnapshots(kind, sessionId, roundMessageId, {
      includeClosed: true,
    });
    return rows.map((row) => {
      const decisions = new Map(
        this.store
          .listRoundHunkDecisions(row.id)
          .map((decision) => [decision.hunk_fingerprint, decision.decision] as const),
      );
      const hunks = row.oversized
        ? []
        : computeHunks(
            row.existed_before ? row.content_before : null,
            row.existed_after ? row.content_after : null,
          );
      let pendingHunks = 0;
      let addedLines = 0;
      let removedLines = 0;
      for (const hunk of hunks) {
        addedLines += hunk.addedCount;
        removedLines += hunk.removedCount;
        if (!decisions.has(hunk.fingerprint)) pendingHunks++;
      }
      return {
        baselineId: row.id,
        roundSnapshotId: row.id,
        roundMessageId: row.round_message_id,
        globalBaselineId: row.global_baseline_id,
        projectId: row.project_id,
        filePath: row.file_path,
        status: row.status,
        existedBefore: !!row.existed_before,
        oversized: !!row.oversized,
        firstSeenAt: row.first_seen_at,
        lastEditedAt: row.last_edited_at,
        closedAt: row.closed_at,
        hunkCount: hunks.length,
        pendingHunks,
        addedLines,
        removedLines,
        resolved: pendingHunks === 0,
      };
    });
  }

  async getRoundDiff(
    roundSnapshotId: number,
    opts: { context?: number; contextBefore?: number; contextAfter?: number } = {},
  ): Promise<FileDiff | null> {
    const row = this.store.getRoundSnapshotById(roundSnapshotId);
    if (!row) return null;
    const decisions = new Map(
      this.store
        .listRoundHunkDecisions(row.id)
        .map((decision) => [decision.hunk_fingerprint, decision.decision] as const),
    );
    const baseline = {
      id: row.id,
      filePath: row.file_path,
      existedBefore: !!row.existed_before,
      oversized: !!row.oversized,
      status: row.status,
      globalBaselineId: row.global_baseline_id,
      roundMessageId: row.round_message_id,
    };
    if (row.oversized) {
      return {
        baseline,
        hunks: [],
        diffDisabled: true,
        currentContent: null,
      };
    }
    const context = opts.context ?? DEFAULT_DIFF_CONTEXT;
    const hunks = computeHunks(
      row.existed_before ? row.content_before : null,
      row.existed_after ? row.content_after : null,
      {
        context,
        contextBefore: opts.contextBefore ?? context,
        contextAfter: opts.contextAfter ?? context,
      },
    ).map((hunk) => ({
      ...hunk,
      decision: (decisions.get(hunk.fingerprint) ?? 'pending') as 'pending' | 'kept' | 'reverted',
    }));
    const after = row.existed_after ? row.content_after : null;
    return {
      baseline,
      hunks,
      diffDisabled: false,
      currentContent: after != null && after.length <= MAX_TRANSPORT_BYTES ? after : null,
    };
  }

  async acceptRoundHunk(
    roundSnapshotId: number,
    fingerprint: string,
  ): Promise<{ ok: boolean; closed: boolean; reason?: string }> {
    return this.withRoundMutex(roundSnapshotId, async () => {
      const row = this.store.getRoundSnapshotById(roundSnapshotId);
      if (!row || row.status !== 'active') {
        return { ok: false, closed: false, reason: 'not-active' };
      }
      const diff = await this.getRoundDiff(roundSnapshotId);
      if (!diff?.hunks.some((hunk) => hunk.fingerprint === fingerprint)) {
        return { ok: false, closed: false, reason: 'stale-fingerprint' };
      }
      this.store.upsertRoundHunkDecision(roundSnapshotId, fingerprint, 'kept');
      const closed = await this.maybeCloseRoundIfNoPending(row.id);
      return { ok: true, closed };
    });
  }

  async revertRoundHunk(
    roundSnapshotId: number,
    fingerprint: string,
  ): Promise<{ ok: boolean; closed: boolean; reason?: string }> {
    return this.withRoundMutex(roundSnapshotId, async () => {
      const row = this.store.getRoundSnapshotById(roundSnapshotId);
      if (!row || row.status !== 'active') {
        return { ok: false, closed: false, reason: 'not-active' };
      }
      if (row.oversized) return { ok: false, closed: false, reason: 'diff-disabled' };
      const projectRoot = this.resolveProjectRoot(row.session_kind, row.session_id, row.project_id);
      if (!projectRoot) return { ok: false, closed: false, reason: 'no-project-root' };
      const diff = await this.getRoundDiff(roundSnapshotId);
      const target = diff?.hunks.find((hunk) => hunk.fingerprint === fingerprint);
      if (!target) return { ok: false, closed: false, reason: 'stale-fingerprint' };
      const abs = absoluteFor(projectRoot, row.file_path);
      const current = await readCurrentContent(abs);
      const reverted = applyHunkRevertFlexible(
        row.existed_before ? row.content_before : null,
        current ?? '',
        target,
      );
      if (reverted == null) return { ok: false, closed: false, reason: 'round-conflict' };
      if (!row.existed_before && reverted === '') {
        await fs.unlink(abs).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, reverted, 'utf8');
      }
      this.store.upsertRoundHunkDecision(roundSnapshotId, fingerprint, 'reverted');
      const closed = await this.maybeCloseRoundIfNoPending(row.id);
      return { ok: true, closed };
    });
  }

  async acceptRoundFile(roundSnapshotId: number): Promise<{ ok: boolean; reason?: string }> {
    const row = this.store.getRoundSnapshotById(roundSnapshotId);
    if (!row || row.status !== 'active') return { ok: false, reason: 'not-active' };
    this.store.closeRoundSnapshot(roundSnapshotId, 'closed_kept');
    return { ok: true };
  }

  async revertRoundFile(roundSnapshotId: number): Promise<{ ok: boolean; reason?: string }> {
    return this.withRoundMutex(roundSnapshotId, async () => {
      const row = this.store.getRoundSnapshotById(roundSnapshotId);
      if (!row || row.status !== 'active') return { ok: false, reason: 'not-active' };
      const planned = await this.planRoundRevert(row.id);
      if (!planned.ok) return { ok: false, reason: planned.reason };
      await this.writeRoundTarget(planned.absPath, planned.targetContent);
      this.store.closeRoundSnapshot(row.id, 'closed_reverted');
      return { ok: true };
    });
  }

  async revertRoundAll(
    kind: SessionKind,
    sessionId: number,
    roundMessageId: number,
  ): Promise<{ ok: boolean; reverted: number; conflicts: Array<{ filePath: string; reason: string }> }> {
    const rows = this.store
      .listRoundSnapshots(kind, sessionId, roundMessageId, { includeClosed: true })
      .filter((row) => row.status === 'active');
    const plans: Array<{
      row: import('@mcp/store/session-file-snapshot-store.js').RoundSnapshotRow;
      absPath: string;
      currentContent: string | null;
      targetContent: string | null;
    }> = [];
    const conflicts: Array<{ filePath: string; reason: string }> = [];
    for (const row of rows) {
      const planned = await this.planRoundRevert(row.id);
      if (!planned.ok) conflicts.push({ filePath: row.file_path, reason: planned.reason });
      else plans.push({ row, ...planned });
    }
    // Conflict preflight is all-or-nothing: never leave a round half reverted.
    if (conflicts.length > 0) return { ok: false, reverted: 0, conflicts };

    const written: typeof plans = [];
    try {
      for (const planned of plans) {
        await this.writeRoundTarget(planned.absPath, planned.targetContent);
        written.push(planned);
      }
    } catch (error) {
      for (const planned of [...written].reverse()) {
        try { await this.writeRoundTarget(planned.absPath, planned.currentContent); } catch { /* best effort */ }
      }
      return {
        ok: false,
        reverted: 0,
        conflicts: [{
          filePath: written.at(-1)?.row.file_path ?? '(filesystem)',
          reason: error instanceof Error ? error.message : String(error),
        }],
      };
    }
    for (const planned of plans) this.store.closeRoundSnapshot(planned.row.id, 'closed_reverted');
    return { ok: true, reverted: plans.length, conflicts: [] };
  }

  async acceptHunk(
    baselineId: number,
    fingerprint: string,
  ): Promise<{ ok: boolean; closed: boolean; reason?: string }> {
    return this.withMutex(baselineId, async () => {
      const b = this.store.getBaselineById(baselineId);
      if (!b || b.status !== 'active') return { ok: false, closed: false, reason: 'not-active' };
      this.store.upsertHunkDecision(baselineId, fingerprint, 'kept');
      const closed = await this.maybeCloseIfNoPending(b);
      return { ok: true, closed };
    });
  }

  async revertHunk(
    baselineId: number,
    fingerprint: string,
  ): Promise<{ ok: boolean; closed: boolean; reason?: string }> {
    return this.withMutex(baselineId, async () => {
      const b = this.store.getBaselineById(baselineId);
      if (!b || b.status !== 'active') return { ok: false, closed: false, reason: 'not-active' };
      if (b.oversized)
        return { ok: false, closed: false, reason: 'oversized — only file-level revert available' };

      const projectRoot = this.resolveProjectRoot(b.session_kind, b.session_id, b.project_id);
      if (!projectRoot) return { ok: false, closed: false, reason: 'no-project-root' };

      const abs = absoluteFor(projectRoot, b.file_path);
      const current = (await readCurrentContent(abs)) ?? '';
      const hunks = computeHunks(b.content_before, current);
      const target = hunks.find((h) => h.fingerprint === fingerprint);
      if (!target) return { ok: false, closed: false, reason: 'stale-fingerprint' };

      const reverted = applyHunkRevert(b.content_before, current, target);
      if (reverted == null)
        return { ok: false, closed: false, reason: 'hunk-no-longer-applies' };

      await fs.writeFile(abs, reverted, 'utf8');
      this.store.upsertHunkDecision(baselineId, fingerprint, 'reverted');
      const closed = await this.maybeCloseIfNoPending(b);
      return { ok: true, closed };
    });
  }

  async acceptFile(baselineId: number): Promise<{ ok: boolean }> {
    return this.withMutex(baselineId, async () => {
      this.store.closeBaseline(baselineId, 'closed_kept');
      return { ok: true };
    });
  }

  async revertFile(baselineId: number): Promise<{ ok: boolean; reason?: string }> {
    return this.withMutex(baselineId, async () => {
      const b = this.store.getBaselineById(baselineId);
      if (!b) return { ok: false, reason: 'not-found' };
      const projectRoot = this.resolveProjectRoot(b.session_kind, b.session_id, b.project_id);
      if (!projectRoot) return { ok: false, reason: 'no-project-root' };

      const abs = absoluteFor(projectRoot, b.file_path);
      if (!b.existed_before) {
        // The file was created during the session — revert = delete.
        try {
          await fs.unlink(abs);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') throw e;
        }
      } else {
        const rollbackContent = b.rollback_content ?? b.content_before;
        if (rollbackContent == null) {
          return { ok: false, reason: 'rollback-content-unavailable' };
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, rollbackContent, 'utf8');
      }
      this.store.markBaselineReverted(baselineId);
      return { ok: true };
    });
  }

  async acceptAll(kind: SessionKind, sessionId: number): Promise<{ closed: number }> {
    const ids = this.store.listActiveBaselineIds(kind, sessionId);
    for (const id of ids) await this.acceptFile(id);
    return { closed: ids.length };
  }

  async revertAll(kind: SessionKind, sessionId: number): Promise<{ closed: number }> {
    const ids = this.store.listActiveBaselineIds(kind, sessionId);
    let closed = 0;
    for (const id of ids) {
      const r = await this.revertFile(id);
      if (r.ok) closed++;
    }
    return { closed };
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private async planRoundRevert(roundSnapshotId: number): Promise<
    | { ok: true; absPath: string; currentContent: string | null; targetContent: string | null }
    | { ok: false; reason: string }
  > {
    const row = this.store.getRoundSnapshotById(roundSnapshotId);
    if (!row) return { ok: false, reason: 'not-found' };
    const projectRoot = this.resolveProjectRoot(row.session_kind, row.session_id, row.project_id);
    if (!projectRoot) return { ok: false, reason: 'no-project-root' };
    const absPath = absoluteFor(projectRoot, row.file_path);
    const currentContent = await readCurrentContent(absPath);
    const before = row.existed_before ? row.content_before ?? '' : null;
    const after = row.existed_after ? row.content_after ?? '' : null;
    if (currentContent === after) {
      return { ok: true, absPath, currentContent, targetContent: before };
    }
    if (row.oversized) return { ok: false, reason: 'round-conflict-large-file' };
    // A round deleted the file and a later round recreated it. There is no safe
    // text merge that can restore the deleted content without overwriting the
    // recreated file, so require manual/global rollback.
    if (after == null || currentContent == null) return { ok: false, reason: 'round-conflict' };

    const hunks = computeHunks(before, after);
    let targetContent = currentContent;
    for (const hunk of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
      const next = applyHunkRevertFlexible(before, targetContent, hunk);
      if (next == null) return { ok: false, reason: 'round-conflict' };
      targetContent = next;
    }
    if (!row.existed_before && targetContent === '') {
      return { ok: true, absPath, currentContent, targetContent: null };
    }
    return { ok: true, absPath, currentContent, targetContent };
  }

  private async writeRoundTarget(absPath: string, content: string | null): Promise<void> {
    if (content == null) {
      await fs.unlink(absPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      return;
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf8');
  }

  private async maybeCloseRoundIfNoPending(roundSnapshotId: number): Promise<boolean> {
    const diff = await this.getRoundDiff(roundSnapshotId);
    if (!diff) return false;
    if (diff.hunks.every((hunk) => hunk.decision !== 'pending')) {
      this.store.closeRoundSnapshot(roundSnapshotId, 'closed_kept');
      return true;
    }
    return false;
  }

  private async maybeCloseIfNoPending(b: BaselineRow): Promise<boolean> {
    const projectRoot = this.resolveProjectRoot(b.session_kind, b.session_id, b.project_id);
    if (!projectRoot) return false;
    const abs = absoluteFor(projectRoot, b.file_path);
    const current = await readCurrentContent(abs);
    const hunks = computeHunks(b.content_before, current);
    if (hunks.length === 0) {
      // No diff left → close as kept (the file is back at baseline OR all
      // changes have been individually accepted/reverted, leaving disk == baseline
      // is the revert-all path; otherwise disk == current with kept hunks
      // baked in). Either way, nothing pending.
      this.store.closeBaseline(b.id, 'closed_kept');
      return true;
    }
    const decisions = new Set(
      this.store.listHunkDecisions(b.id).map((d) => d.hunk_fingerprint),
    );
    const pending = hunks.filter((h) => !decisions.has(h.fingerprint));
    if (pending.length === 0) {
      this.store.closeBaseline(b.id, 'closed_kept');
      return true;
    }
    return false;
  }

  private async withMutex<T>(baselineId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutexes.get(baselineId);
    const next = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // ignore prior failures; we still want our turn.
        }
      }
      return fn();
    })();
    this.mutexes.set(baselineId, next);
    try {
      return await next;
    } finally {
      // Only clear if it's still the same promise (next op may have replaced it).
      if (this.mutexes.get(baselineId) === next) this.mutexes.delete(baselineId);
    }
  }

  private async withRoundMutex<T>(roundSnapshotId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.roundMutexes.get(roundSnapshotId);
    const next = (async () => {
      if (previous) {
        try { await previous; } catch { /* continue after prior failure */ }
      }
      return fn();
    })();
    this.roundMutexes.set(roundSnapshotId, next);
    try {
      return await next;
    } finally {
      if (this.roundMutexes.get(roundSnapshotId) === next) {
        this.roundMutexes.delete(roundSnapshotId);
      }
    }
  }
}
