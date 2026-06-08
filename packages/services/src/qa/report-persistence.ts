/**
 * v4.5 — host-side persistence of Playwright artifacts.
 *
 * The user's pain (sessions like 68): once a sandbox is destroyed —
 * orphan recovery, session cleanup, server restart, container rebuild —
 * the operator loses every screenshot, video, trace, and the HTML report.
 * The DB still has `qa_test_runs` rows but the file-paths in
 * `screenshot_path` / `video_path` / `trace_path` no longer resolve.
 *
 * This helper runs once per `qa_run_completed`: it walks
 * `playwright-report/` and `test-results/` inside the sandbox, copies
 * every file to a host directory under
 * `<mcpDataDir>/qa-reports/<sessionId>/<runId>/`
 * (i.e. `~/.mcp-code-indexer/qa-reports/…`), and stamps
 * the absolute path on `qa_test_runs.report_persisted_path`. The
 * artifacts route then prefers that path over the (possibly gone)
 * sandbox.
 *
 * Best-effort by design — failures are logged but never thrown back to
 * the test-event handler. Losing evidence is sad, but the run row is
 * the source of truth and must always be marked `completed` regardless
 * of whether the copy succeeded. A partial copy is also fine: the
 * dashboard renders what it finds.
 *
 * Pure-ish: takes the manager + store as arguments so unit tests can
 * inject fakes and assert the surface (cap, list, write order).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { qaReportsDir } from '@mcp/shared/utils/data-paths.js';
import type { SandboxManager } from '../sandbox/sandbox-manager.js';
import type { IQaTestRunStore } from './store/interfaces.js';

const SOURCE_DIRS = ['playwright-report', 'test-results'] as const;
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1 GiB per run
const DEFAULT_PER_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB per file

export interface PersistRunArtifactsOpts {
  sessionId: number;
  runId: number;
  serviceId: string;
  /** Override base dir. Defaults to `<mcpDataDir>/qa-reports`. */
  baseDir?: string;
  /** Override total cap. Defaults to MCP_QA_PERSIST_MAX_BYTES_PER_RUN env or 1 GiB. */
  maxBytes?: number;
  /** Override per-file cap. Defaults to 50 MiB. */
  perFileMaxBytes?: number;
}

export interface PersistRunArtifactsResult {
  /** Absolute path to the run-scoped directory on the host (set even on partial failure). */
  absolutePath: string;
  /** Number of files successfully copied. */
  copied: number;
  /** Files skipped because they exceeded the per-file cap. */
  skippedTooLarge: string[];
  /** Files we abandoned because the run-total cap was exhausted. */
  skippedBudget: string[];
  /** Soft errors (per-file read/write failures). */
  warnings: string[];
}

/**
 * Pure: resolve the host directory for a `(sessionId, runId)` pair.
 * Exported so the artifacts route can compute the same path on read
 * without re-computing the env-var defaulting logic.
 */
export function resolveRunReportDir(
  sessionId: number | string,
  runId: number | string,
  baseDir?: string,
): string {
  const root = (baseDir ?? mcpDataDir()).replace(/[\\/]+$/, '');
  return path.resolve(path.join(root, 'qa-reports', String(sessionId), String(runId)));
}

/**
 * Resolve the env-driven default for `maxBytes`. Exported for tests.
 */
export function resolveDefaultMaxBytes(): number {
  const raw = process.env.MCP_QA_PERSIST_MAX_BYTES_PER_RUN;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BYTES;
  return n;
}

/**
 * Copy `playwright-report/` and `test-results/` from the sandbox to the
 * host. Returns a structured report; never throws (catches and logs).
 *
 * Caller is responsible for stamping `report_persisted_path` on the run
 * row — we keep the store-write outside the helper so unit tests can
 * use the helper without instantiating a store.
 */
export async function persistRunArtifacts(
  manager: Pick<
    SandboxManager,
    'listWorkspaceFilesOnService' | 'readWorkspaceFileBufferOnService'
  >,
  opts: PersistRunArtifactsOpts,
): Promise<PersistRunArtifactsResult> {
  const baseDir = opts.baseDir ?? qaReportsDir();
  const absolutePath = resolveRunReportDir(opts.sessionId, opts.runId, baseDir);
  const maxBytes = opts.maxBytes ?? resolveDefaultMaxBytes();
  const perFileMax = opts.perFileMaxBytes ?? DEFAULT_PER_FILE_MAX_BYTES;

  const result: PersistRunArtifactsResult = {
    absolutePath,
    copied: 0,
    skippedTooLarge: [],
    skippedBudget: [],
    warnings: [],
  };

  try {
    await fs.mkdir(absolutePath, { recursive: true });
  } catch (e) {
    result.warnings.push(`mkdir ${absolutePath} failed: ${errMsg(e)}`);
    return result;
  }

  let usedBytes = 0;
  for (const sourceDir of SOURCE_DIRS) {
    let files: string[];
    try {
      files = await manager.listWorkspaceFilesOnService(
        String(opts.sessionId),
        opts.serviceId,
        sourceDir,
      );
    } catch (e) {
      result.warnings.push(`list ${sourceDir} failed: ${errMsg(e)}`);
      continue;
    }
    if (files.length === 0) continue;

    for (const rel of files) {
      const sourceRel = `${sourceDir}/${rel}`;
      // Budget guard — if even reading the file would exceed the cap,
      // skip without attempting the read (saves a base64 round-trip).
      const remaining = maxBytes - usedBytes;
      if (remaining <= 0) {
        result.skippedBudget.push(sourceRel);
        continue;
      }
      // Track whether the active cap is the per-file ceiling or the
      // run-budget remaining — used to classify a "too large" failure
      // as `skippedTooLarge` (the file exceeds its per-file ceiling)
      // vs. `skippedBudget` (we ran out of run-total budget).
      const budgetIsBinding = remaining < perFileMax;
      const readCap = Math.min(perFileMax, remaining);

      let buf: Buffer;
      try {
        buf = await manager.readWorkspaceFileBufferOnService(
          String(opts.sessionId),
          opts.serviceId,
          sourceRel,
          { maxBytes: readCap },
        );
      } catch (e) {
        const msg = errMsg(e);
        // Distinguish "file too large" from real read errors so the
        // operator sees the right label in the UI.
        if (/larger|too large|max/i.test(msg)) {
          if (budgetIsBinding) result.skippedBudget.push(sourceRel);
          else result.skippedTooLarge.push(sourceRel);
        } else {
          result.warnings.push(`read ${sourceRel} failed: ${msg}`);
        }
        continue;
      }

      const targetAbs = path.join(absolutePath, sourceRel);
      try {
        await fs.mkdir(path.dirname(targetAbs), { recursive: true });
        await fs.writeFile(targetAbs, buf);
        usedBytes += buf.byteLength;
        result.copied += 1;
      } catch (e) {
        result.warnings.push(`write ${sourceRel} failed: ${errMsg(e)}`);
      }
    }
  }

  return result;
}

/**
 * Convenience: persist + stamp the run row in one shot. Used by the
 * test-event route on `completed`. Logs warnings but never throws.
 */
export async function persistAndStamp(
  manager: Pick<
    SandboxManager,
    'listWorkspaceFilesOnService' | 'readWorkspaceFileBufferOnService'
  >,
  runStore: Pick<IQaTestRunStore, 'setReportPersistedPath'>,
  opts: PersistRunArtifactsOpts,
): Promise<PersistRunArtifactsResult> {
  const report = await persistRunArtifacts(manager, opts);
  if (report.copied > 0) {
    try {
      runStore.setReportPersistedPath(opts.runId, report.absolutePath);
    } catch (e) {
      report.warnings.push(`stamp report_persisted_path failed: ${errMsg(e)}`);
    }
  }
  return report;
}

/**
 * Retention pruning — delete every host-side run dir for a session
 * except the most recent `keep` (sorted numerically by runId, since
 * they're auto-incremented). Used by `qa_start_run`'s pre-flight so
 * the disk doesn't grow unboundedly run after run.
 *
 * Best-effort: rmdir failures are surfaced but never thrown.
 */
export async function pruneOldRunDirs(
  sessionId: number | string,
  keep: number,
  baseDir?: string,
): Promise<{ removed: string[]; warnings: string[] }> {
  const sessionDir = path.dirname(resolveRunReportDir(sessionId, 0, baseDir));
  const out: { removed: string[]; warnings: string[] } = { removed: [], warnings: [] };
  let entries: string[];
  try {
    entries = await fs.readdir(sessionDir);
  } catch (e) {
    const msg = errMsg(e);
    if (/ENOENT|no such file/i.test(msg)) return out;
    out.warnings.push(`readdir ${sessionDir} failed: ${msg}`);
    return out;
  }
  const numeric = entries
    .map((e) => ({ name: e, n: Number(e) }))
    .filter((e) => Number.isFinite(e.n) && e.n > 0)
    .sort((a, b) => b.n - a.n);
  const toDelete = numeric.slice(Math.max(0, keep));
  for (const { name } of toDelete) {
    const target = path.join(sessionDir, name);
    try {
      await fs.rm(target, { recursive: true, force: true });
      out.removed.push(target);
    } catch (e) {
      out.warnings.push(`rm ${target} failed: ${errMsg(e)}`);
    }
  }
  return out;
}

/**
 * Pure: resolve the env-driven default for `MCP_QA_RETAIN_RUNS`.
 * Falls back to 5. Exported for the qa_start_run tool + tests.
 */
export function resolveRetainRuns(): number {
  const raw = process.env.MCP_QA_RETAIN_RUNS;
  if (!raw) return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5;
  return Math.floor(n);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
