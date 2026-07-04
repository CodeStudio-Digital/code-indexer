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
import type { SftpProgress, SshConnectSpec } from '@mcp/api-bus';
import { sftpCancel, sftpDownload, sftpUpload } from '../api.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { askConflict, type ConflictAction, type ConflictChoice } from './conflict-dialog.js';
import { baseName, type FsAdapter, type FsItem } from './fs-adapter.js';
import { foldPath, nextFreeName, planTransfer, remapRoot, type TransferPlan } from './transfer-walk.js';

export interface Transfer {
  id: string;
  name: string;
  dir: 'up' | 'down';
  transferred: number;
  total: number;
  done?: boolean;
  error?: string;
  cancelled?: boolean;
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

  const cancel = useCallback((id: string) => {
    setTransfers((ts) => ts.map((x) => (x.id === id ? { ...x, cancelled: true } : x)));
    void sftpCancel(id).catch(() => undefined);
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
        // Pre-create destination dirs (BFS order = parent-first, so remote mkdir is fine).
        for (const relDir of plan.dirs) {
          const full = foldPath(dest.join, destDir, relDir);
          await dest.mkdir(dest.parentDir(full), baseName(full)).catch(() => undefined);
        }
        for (const f of plan.files) {
          const destFull = foldPath(dest.join, destDir, f.relPath);
          const id = `${src.kind}->${dest.kind}:${destFull}`;
          any = true;
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
        }
      }
      return any;
    },
    [spec, runTransfer, t],
  );

  return { transfers, transferItems, cancel };
}
