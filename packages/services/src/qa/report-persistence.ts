/**
 * v4.5 — host-side persistence of Playwright artifacts.
 *
 * Once a sandbox is destroyed —
 * orphan recovery, session cleanup, server restart, container rebuild —
 * the operator loses every screenshot, video, trace, and the HTML report.
 *
 * This helper runs once per `qa_run_completed`: it walks
 * `playwright-report/` and `test-results/` inside the sandbox, copies
 * every file to
 * `<session bundle>/company/qa-artifacts/<run UUID>/`, and stamps that
 * path on the file-backed QA run entity. The
 * artifacts route then prefers that path over the (possibly gone)
 * sandbox.
 *
 * Best-effort by design — failures are logged but never thrown back to
 * the test-event handler. Losing evidence is sad, but the run entity is
 * the source of truth and must always be marked `completed` regardless
 * of whether the copy succeeded. A partial copy is also fine: the
 * dashboard renders what it finds. Artifacts are never pruned by age or
 * count; deleting the owning session is the only retention boundary.
 *
 * Pure-ish: takes the manager + store as arguments so unit tests can
 * inject fakes and assert the surface (cap, list, write order).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  assertContainedPath,
  assertSafeFileName,
  atomicWriteFile,
  ensureDirectoryTreeNoLinks,
} from '@mcp/session-storage';
import type { SandboxManager } from '../sandbox/sandbox-manager.js';
import type { IQaTestRunStore } from './store/interfaces.js';

const SOURCE_DIRS = ['playwright-report', 'test-results'] as const;
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1 GiB per run
const DEFAULT_PER_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB per file

export interface PersistRunArtifactsOpts {
  sessionId: string;
  runId: string;
  serviceId: string;
  /**
   * Exact run directory inside the owning session bundle. Required:
   * there is deliberately no central data-dir fallback.
   */
  outputDirectory: string;
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
 * entity — we keep the store-write outside the helper so unit tests can
 * use the helper without instantiating a store.
 */
export async function persistRunArtifacts(
  manager: Pick<
    SandboxManager,
    'listWorkspaceFilesOnService' | 'readWorkspaceFileBufferOnService'
  >,
  opts: PersistRunArtifactsOpts,
): Promise<PersistRunArtifactsResult> {
  const absolutePath = path.resolve(opts.outputDirectory);
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
    await fs.access(absolutePath);
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
      let relativeSegments: string[];
      try {
        relativeSegments = safeRelativeSegments(rel);
      } catch (e) {
        result.warnings.push(`unsafe ${sourceDir} path ignored: ${errMsg(e)}`);
        continue;
      }
      const sourceRel = `${sourceDir}/${relativeSegments.join('/')}`;
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

      const targetAbs = path.join(
        absolutePath,
        assertSafeFileName(sourceDir, 'QA artifact source directory'),
        ...relativeSegments,
      );
      assertContainedPath(absolutePath, targetAbs);
      try {
        await ensureDirectoryTreeNoLinks(
          absolutePath,
          path.dirname(targetAbs),
        );
        await atomicWriteFile(targetAbs, buf);
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
 * Convenience: persist + stamp the run entity in one shot. Used by the
 * test-event route on `completed`. Logs warnings but never throws.
 */
export async function persistAndStamp(
  manager: Pick<
    SandboxManager,
    'listWorkspaceFilesOnService' | 'readWorkspaceFileBufferOnService'
  >,
  runStore: Pick<
    IQaTestRunStore,
    'setReportPersistedPath' | 'withRunArtifactDirectory'
  >,
  opts: Omit<PersistRunArtifactsOpts, 'outputDirectory'>,
): Promise<PersistRunArtifactsResult> {
  const report = await runStore.withRunArtifactDirectory(
    opts.sessionId,
    opts.runId,
    (outputDirectory) =>
      persistRunArtifacts(manager, {
        ...opts,
        outputDirectory,
      }),
  );
  // Stamp in a second short writer operation. Calling this inside
  // withRunArtifactDirectory would recursively acquire the same
  // session writer/lease.
  if (report.copied > 0) {
    try {
      await runStore.setReportPersistedPath(
        opts.runId,
        report.absolutePath,
      );
    } catch (e) {
      report.warnings.push(
        `stamp report_persisted_path failed: ${errMsg(e)}`,
      );
    }
  }
  return report;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeRelativeSegments(value: string): string[] {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) {
    throw new Error(`invalid relative path ${JSON.stringify(value)}`);
  }
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.length === 0) {
    throw new Error(`invalid relative path ${JSON.stringify(value)}`);
  }
  return segments.map((segment) =>
    assertSafeFileName(segment, 'QA artifact path segment'),
  );
}
