/**
 * `coder snapshot` — CLI parity with the dashboard Snapshots tab.
 *
 * Useful in CI, scripts, or terminal-only environments to inspect / accept /
 * revert the cumulative diff captured during an agent session.
 */
import type { Command } from 'commander';
import { loadConfig, mcpDataDir } from '@mcp/shared/utils/config.js';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { asSessionId, isUuid } from '@mcp/session-storage';
import {
  SessionSnapshotService,
  type FileSummary,
} from '@mcp/services/services/session-snapshots.js';

function makeService() {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const sessionStore = FsSessionStore.fromRoots({
    dataDir: mcpDataDir(),
    projectRootResolver: {
      resolveProjectRoot: (id) => db.getProject(id)?.root_path,
      listProjectRoots: () =>
        db.listProjects().map((project) => ({
          project_id: project.id,
          root_path: project.root_path,
        })),
    },
    projectInfoResolver: (id) => {
      const project = db.getProject(id);
      return project
        ? {
            project_id: project.id,
            name: project.name,
            root_path: project.root_path,
          }
        : null;
    },
  });
  const snapshotStore = sessionStore;
  const service = new SessionSnapshotService(snapshotStore, async (kind, sessionId) => {
    if (kind !== 'coder') return null;
    const s = await sessionStore.getSession(sessionId);
    if (!s) return null;
    if (s.project_id == null) return null;
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
  return `  ${String(f.baselineId).slice(0, 8)} [${kind}] ${f.filePath} — ${status}`;
}

function sessionId(value: string) {
  if (!isUuid(value)) throw new Error('session-id must be a canonical UUID');
  return asSessionId(value.toLowerCase());
}

function recordId(value: string): string {
  if (!isUuid(value)) throw new Error('snapshot record id must be a canonical UUID');
  return value.toLowerCase();
}

export function register(program: Command): void {
  const cmd = program.command('coder-snapshot').description('Per-session file snapshots (review / keep / undo)');

  cmd
    .command('list <session-id>')
    .description('List files altered in this session (active by default; --all includes closed).')
    .option('--all', 'Include closed (kept/reverted) baselines')
    .action(async (id: string, opts: { all?: boolean }) => {
      const idValue = sessionId(id);
      const { service } = makeService();
      const files = await service.listFiles('coder', idValue, {
        includeClosed: !!opts.all,
      });
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
      const baselineId = recordId(id);
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
      const idValue = sessionId(id);
      const { service } = makeService();
      if (opts.file && opts.hunk) {
        const r = await service.acceptHunk(recordId(opts.file), opts.hunk);
        console.log(JSON.stringify(r));
      } else if (opts.file) {
        const r = await service.acceptFile(recordId(opts.file));
        console.log(JSON.stringify(r));
      } else {
        const r = await service.acceptAll('coder', idValue);
        console.log(`Closed ${r.closed} baseline(s) as kept.`);
      }
    });

  cmd
    .command('undo <session-id>')
    .description('Revert all active baselines of this session to their pre-edit state.')
    .option('--file <baseline-id>', 'Revert a single baseline only')
    .option('--hunk <fingerprint>', 'When combined with --file, revert a single hunk only')
    .action(async (id: string, opts: { file?: string; hunk?: string }) => {
      const idValue = sessionId(id);
      const { service } = makeService();
      if (opts.file && opts.hunk) {
        const r = await service.revertHunk(recordId(opts.file), opts.hunk);
        console.log(JSON.stringify(r));
      } else if (opts.file) {
        const r = await service.revertFile(recordId(opts.file));
        console.log(JSON.stringify(r));
      } else {
        const r = await service.revertAll('coder', idValue);
        console.log(`Reverted ${r.closed} baseline(s).`);
      }
    });
}
