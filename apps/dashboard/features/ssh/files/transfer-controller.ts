/**
 * Transfer controller — owns the in-flight transfer list + the cross-pane
 * `transferItems` orchestration. Direction is derived from the source adapter's
 * kind: local→remote uploads, remote→local downloads, both via the existing
 * per-file `sftpUpload`/`sftpDownload` streams (which do the disk I/O in main).
 * Folders are walked in the renderer (`planTransfer`) and their dirs pre-created
 * on the destination; same-name collisions are resolved per top-level item.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArchiveProgress, SftpProgress, SshConnectSpec } from '@mcp/api-bus';
import { mapLimit } from '@mcp/shared/utils/map-limit.js';
import { apiCall } from '../../../lib/api-client.js';
import { sftpCancel, sftpDownload, sftpUpload } from '../api.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { askConflict, type ConflictAction, type ConflictChoice } from './conflict-dialog.js';
import { baseName, type FsAdapter, type FsItem } from './fs-adapter.js';
import { foldPath, nextFreeName, planTransfer, remapRoot, type TransferPlan } from './transfer-walk.js';

/**
 * `zip`/`unzip` reuse this list so a compression job gets the same progress row
 * and cancel button as a transfer — the work is a worker thread rather than an
 * SFTP channel, which only changes which cancel API `cancel()` calls.
 */
export type TransferDir = 'up' | 'down' | 'zip' | 'unzip';

export interface Transfer {
  id: string;
  name: string;
  dir: TransferDir;
  transferred: number;
  total: number;
  done?: boolean;
  error?: string;
  cancelled?: boolean;
}

const isArchiveDir = (dir: TransferDir): boolean => dir === 'zip' || dir === 'unzip';

const archiveCancel = (archiveId: string) => apiCall('files.archiveCancel', { archiveId });

/**
 * Concurrent SFTP operations. Every transfer opens its own channel, and
 * OpenSSH's default `MaxSessions` is 10 per connection — shared with the browse
 * session, any tunnels and any open shells. 4 leaves headroom; 8+ risks
 * "Channel open failure" on a stock sshd.
 */
const TRANSFER_CONCURRENCY = 4;

/** Group relative dir paths into depth levels, shallowest first. */
function byDepth(dirs: string[]): string[][] {
  const levels: string[][] = [];
  for (const d of dirs) {
    const depth = d.split('/').length - 1;
    (levels[depth] ??= []).push(d);
  }
  return levels.filter(Boolean);
}

export function useTransfers(spec: SshConnectSpec | null) {
  const { t } = useTranslation('ssh');
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  const update = useCallback((id: string, patch: Partial<Transfer>) => {
    setTransfers((ts) => ts.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  const runTransfer = useCallback(
    async (tf: Transfer, stream: AsyncIterable<SftpProgress>) => {
      setTransfers((ts) => [...ts.filter((x) => x.id !== tf.id), tf]);
      const label = tf.dir === 'up' ? t('sftp.uploaded', { name: tf.name }) : t('sftp.downloaded', { name: tf.name });
      const isCancel = (msg?: string) => msg === 'transfer cancelled';
      try {
        for await (const p of stream) {
          if (p.type === 'progress') update(tf.id, { transferred: p.transferred, total: p.total || tf.total });
          else if (p.type === 'done') {
            update(tf.id, { done: true });
            toast.success(label);
          } else if (p.type === 'error') {
            const cancelled = isCancel(p.message);
            update(tf.id, { done: true, cancelled, error: cancelled ? undefined : p.message });
            if (!cancelled) toast.error(t('sftp.actionError', { reason: p.message }));
          }
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const cancelled = isCancel(reason);
        update(tf.id, { done: true, cancelled, error: cancelled ? undefined : reason });
        if (!cancelled) toast.error(t('sftp.actionError', { reason }));
      }
      setTimeout(() => setTransfers((ts) => ts.filter((x) => x.id !== tf.id)), 4000);
    },
    [update, t],
  );

  /**
   * Run an archive/extract job, mapping its worker frames onto the same
   * progress row a transfer uses. Kept separate from `runTransfer` because the
   * frame shape differs: SFTP streams carry tagged progress/done/error frames,
   * the archive worker yields a plain progress object and signals failure by
   * throwing.
   */
  const runArchive = useCallback(
    async (tf: Transfer, stream: AsyncIterable<ArchiveProgress>, successLabel: string): Promise<boolean> => {
      setTransfers((ts) => [...ts.filter((x) => x.id !== tf.id), tf]);
      let ok = false;
      try {
        for await (const p of stream) {
          update(tf.id, { transferred: p.bytes, total: p.totalBytes || tf.total });
          if (p.done) ok = true;
        }
        if (ok) toast.success(successLabel);
        else update(tf.id, { cancelled: true }); // stream ended without `done` → cancelled
        update(tf.id, { done: true });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        update(tf.id, { done: true, error: reason });
        toast.error(t('files.zipFailed', { reason }));
      }
      setTimeout(() => setTransfers((ts) => ts.filter((x) => x.id !== tf.id)), 4000);
      return ok;
    },
    [update, t],
  );

  const cancel = useCallback((id: string) => {
    let dir: TransferDir | undefined;
    setTransfers((ts) =>
      ts.map((x) => {
        if (x.id !== id) return x;
        dir = x.dir;
        return { ...x, cancelled: true };
      }),
    );
    // An archive job lives in a worker thread, not an SFTP channel.
    const stop = dir && isArchiveDir(dir) ? archiveCancel(id) : sftpCancel(id);
    void stop.catch(() => undefined);
  }, []);

  /** Copy `items` from `src` into `destDir` on `dest`. Returns true if anything transferred. */
  const transferItems = useCallback(
    async (src: FsAdapter, dest: FsAdapter, destDir: string, items: FsItem[]): Promise<boolean> => {
      if (!spec || items.length === 0) return false;

      // Resolve same-name collisions once, over the destination's top-level names.
      const destEntries = await dest.list(destDir).catch(() => [] as FsItem[]);
      const taken = new Set(destEntries.map((e) => e.name));
      let applyAll: ConflictAction | null = null;
      const jobs: Array<{ item: FsItem; targetBase: string }> = [];
      for (const it of items) {
        if (it.type !== 'file' && it.type !== 'dir') continue;
        if (!taken.has(it.name)) {
          taken.add(it.name);
          jobs.push({ item: it, targetBase: it.name });
          continue;
        }
        const choice: ConflictChoice = applyAll ? { action: applyAll, applyToAll: true } : await askConflict(it.name);
        if (choice.applyToAll) applyAll = choice.action;
        if (choice.action === 'skip') continue;
        if (choice.action === 'overwrite') {
          jobs.push({ item: it, targetBase: it.name });
          continue;
        }
        const fresh = nextFreeName(it.name, taken, it.type === 'file');
        taken.add(fresh);
        jobs.push({ item: it, targetBase: fresh });
      }

      let any = false;
      for (const job of jobs) {
        let plan: TransferPlan;
        try {
          plan = await planTransfer([job.item], src);
        } catch {
          toast.error(t('files.tooManyFiles'));
          continue;
        }
        if (job.targetBase !== job.item.name) plan = remapRoot(plan, job.item.name, job.targetBase);
        any = true; // a job always creates at least its own dir/file → the dest changed

        // Pre-create destination dirs. Grouped BY DEPTH: siblings are created
        // concurrently, but a whole level must land before the next starts —
        // remote mkdir is non-recursive, so a child created before its parent
        // fails. (`plan.dirs` is parent-first, which depth grouping preserves.)
        for (const level of byDepth(plan.dirs)) {
          await mapLimit(level, TRANSFER_CONCURRENCY, async (relDir) => {
            const full = foldPath(dest.join, destDir, relDir);
            await dest.mkdir(dest.parentDir(full), baseName(full)).catch(() => undefined);
          });
        }

        // Files, a few at a time. Each fastGet/fastPut opens its OWN SFTP
        // channel and OpenSSH's default MaxSessions is 10 per connection —
        // shared with the browse session, any tunnel and any open shell — so
        // the cap stays well under it. A single large file already saturates
        // the link (ssh2 pipelines 64 chunks internally); the win here is on
        // many small files, where per-file round-trips dominate.
        await mapLimit(plan.files, TRANSFER_CONCURRENCY, async (f) => {
          const destFull = foldPath(dest.join, destDir, f.relPath);
          const id = `${src.kind}->${dest.kind}:${destFull}`;
          if (src.kind === 'local') {
            await runTransfer(
              { id, name: baseName(f.relPath), dir: 'up', transferred: 0, total: f.size },
              sftpUpload(spec, src.toLocalAbs(f.srcPath), destFull, id),
            );
          } else {
            await runTransfer(
              { id, name: baseName(f.relPath), dir: 'down', transferred: 0, total: f.size },
              sftpDownload(spec, f.srcPath, dest.toLocalAbs(destFull), id),
            );
          }
        });
      }
      return any;
    },
    [spec, runTransfer, t],
  );

  return { transfers, transferItems, runArchive, cancel };
}
