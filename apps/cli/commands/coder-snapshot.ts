/**
 * `coder snapshot` — CLI parity with the dashboard Snapshots tab.
 *
 * Useful in CI, scripts, or terminal-only environments to inspect / accept /
 * revert the cumulative diff captured during an agent session.
 */
import type { Command } from 'commander';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import {
  SessionSnapshotService,
  type FileSummary,
} from '@mcp/services/services/session-snapshots.js';

function makeService() {
  const config = loadConfig();
  const sessionStore = new SessionStore(config.dbPath);
  const db = new CodeIndexDB(config.dbPath);
  const snapshotStore = new SessionFileSnapshotStore(sessionStore.getDb());
  const service = new SessionSnapshotService(snapshotStore, (kind, sessionId) => {
    if (kind !== 'coder') return null;
    const s = sessionStore.getSession(sessionId);
    if (!s) return null;
    const p = db.getProject(s.project_id);
    return p?.root_path ?? null;
  });
  return { service, snapshotStore, sessionStore, db };
}

function summaryLine(f: FileSummary): string {
  const status =
    f.status === 'active'
      ? `${f.pendingHunks}h pending`
      : f.status === 'closed_kept'
        ? 'kept'
        : 'reverted';
  const kind = !f.existedBefore ? 'A' : f.removedLines && !f.addedLines ? 'D' : 'M';
  return `  #${f.baselineId.toString().padStart(4)} [${kind}] ${f.filePath} — ${status}`;
}

export function register(program: Command): void {
  const cmd = program.command('coder-snapshot').description('Per-session file snapshots (review / keep / undo)');

  cmd
    .command('list <session-id>')
    .description('List files altered in this session (active by default; --all includes closed).')
    .option('--all', 'Include closed (kept/reverted) baselines')
    .action(async (id: string, opts: { all?: boolean }) => {
      const sessionId = parseInt(id, 10);
      if (!Number.isFinite(sessionId)) {
        console.error('Invalid session id');
        process.exit(1);
      }
      const { service } = makeService();
      const files = await service.listFiles('coder', sessionId, { includeClosed: !!opts.all });
      if (files.length === 0) {
        console.log('  (no snapshots)');
        return;
      }
      for (const f of files) console.log(summaryLine(f));
    });

  cmd
    .command('diff <baseline-id>')
    .description('Print the diff for a single file baseline (unified, hunk-by-hunk).')
    .action(async (id: string) => {
      const baselineId = parseInt(id, 10);
      const { service } = makeService();
      const diff = await service.getDiff(baselineId);
      if (!diff) {
        console.error('Baseline not found');
        process.exit(1);
      }
      console.log(`--- ${diff.baseline.filePath} (baseline)`);
      console.log(`+++ ${diff.baseline.filePath} (current)`);
      if (diff.diffDisabled) {
        console.log('  (diff disabled — file is too large or binary)');
        return;
      }
      for (const h of diff.hunks) {
        console.log(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ (${h.fingerprint} ${h.decision})`);
        for (const line of h.lines) {
          const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
          console.log(prefix + line.content);
        }
      }
    });

  cmd
    .command('keep <session-id>')
    .description('Mark all active baselines of this session as kept (closes them — files stay as-is on disk).')
    .option('--file <baseline-id>', 'Keep a single baseline only')
    .option('--hunk <fingerprint>', 'When combined with --file, keep a single hunk only')
    .action(async (id: string, opts: { file?: string; hunk?: string }) => {
      const sessionId = parseInt(id, 10);
      const { service } = makeService();
      if (opts.file && opts.hunk) {
        const r = await service.acceptHunk(parseInt(opts.file, 10), opts.hunk);
        console.log(JSON.stringify(r));
      } else if (opts.file) {
        const r = await service.acceptFile(parseInt(opts.file, 10));
        console.log(JSON.stringify(r));
      } else {
        const r = await service.acceptAll('coder', sessionId);
        console.log(`Closed ${r.closed} baseline(s) as kept.`);
      }
    });

  cmd
    .command('undo <session-id>')
    .description('Revert all active baselines of this session to their pre-edit state.')
    .option('--file <baseline-id>', 'Revert a single baseline only')
    .option('--hunk <fingerprint>', 'When combined with --file, revert a single hunk only')
    .action(async (id: string, opts: { file?: string; hunk?: string }) => {
      const sessionId = parseInt(id, 10);
      const { service } = makeService();
      if (opts.file && opts.hunk) {
        const r = await service.revertHunk(parseInt(opts.file, 10), opts.hunk);
        console.log(JSON.stringify(r));
      } else if (opts.file) {
        const r = await service.revertFile(parseInt(opts.file, 10));
        console.log(JSON.stringify(r));
      } else {
        const r = await service.revertAll('coder', sessionId);
        console.log(`Reverted ${r.closed} baseline(s).`);
      }
    });
}
