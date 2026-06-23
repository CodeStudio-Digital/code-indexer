/**
 * v4.4 — Pure-ish helper that brings the QA workspace back to the
 * MCP-managed contract. Re-used by:
 *
 *   - `qa_start_run` (every time the agent kicks a run, so accidental
 *     edits don't slip through)
 *   - `POST /api/company/sessions/:id/qa/restore-config` (operator
 *     button on Tab Testes — one-click recovery without waiting for
 *     the next agent run)
 *
 * Side effects (all best-effort, never throw):
 *   1. Force-restore `tests/e2e/reporter.ts` from `REPORTER_TEMPLATE`.
 *   2. Force-restore `tests/e2e/global-setup.ts` from `QA_GLOBAL_SETUP_TEMPLATE`.
 *   3. Read `playwright.config.ts` and validate critical keys.
 *   4. When drift is detected, write `playwright.config.recommended.ts`
 *      next to the user file so they can diff + restore manually.
 *   5. Optionally write `tests/e2e/.mcp-qa-run.json` (only when the
 *      caller has a runId — `qa_start_run` does, the operator button
 *      does NOT, since there's no run to associate with).
 *
 * Returns a typed report that both call sites can render to the user.
 */
import type { SandboxManager } from '../sandbox/sandbox-manager.js';
import { REPORTER_TEMPLATE } from './playwright-reporter/reporter-template.js';
import {
  validatePlaywrightConfig,
  renderPlaywrightConfig,
  QA_GLOBAL_SETUP_TEMPLATE,
} from '../sandbox/scaffolders/playwright-bootstrap.js';
import { pruneOldRunDirs, resolveRetainRuns } from './report-persistence.js';

export interface WorkspaceRestoreReport {
  runConfigWritten: boolean;
  reporterRestored: boolean;
  globalSetupRestored: boolean;
  /** Missing critical keys from `validatePlaywrightConfig`. */
  configMissing: string[];
  /** v4.5 — non-critical drift recommendations (yellow chips on the UI). */
  configRecommendations: string[];
  /** True when we wrote `playwright.config.recommended.ts` next to the user file. */
  configRecommendedWritten: boolean;
  /**
   * v4.5 — host-side run dirs pruned by the retention policy
   * (`MCP_QA_RETAIN_RUNS`, default 5). Surfaces in the agent's
   * `qa_start_run` reply so the operator sees what was reclaimed.
   */
  prunedRunDirs: string[];
  /**
   * v4.5 — sandbox dirs we wiped before the new run started
   * (`tests/e2e/test-results`, `tests/e2e/playwright-report`). Empty
   * when the directories did not exist or the manager has no driver
   * (test mode).
   */
  wipedSandboxDirs: string[];
  /** Soft errors collected during the restore pass. */
  warnings: string[];
}

export function emptyReport(): WorkspaceRestoreReport {
  return {
    runConfigWritten: false,
    reporterRestored: false,
    globalSetupRestored: false,
    configMissing: [],
    configRecommendations: [],
    configRecommendedWritten: false,
    prunedRunDirs: [],
    wipedSandboxDirs: [],
    warnings: [],
  };
}

export interface RestoreOptions {
  sessionId: number | string;
  /** When provided, also writes `tests/e2e/.mcp-qa-run.json`. */
  runConfig?: { runId: string | number; endpoint: string };
  /** Default 5173 — same as the scaffolder. */
  devServerPort?: number;
  /**
   * v4.5 — when true (default), the restore pass also:
   *   - prunes old `data/qa-reports/<sessionId>/<runId>/` dirs to keep
   *     only the last `MCP_QA_RETAIN_RUNS` (default 5) on host disk;
   *   - wipes `tests/e2e/test-results/` and `tests/e2e/playwright-report/`
   *     in the sandbox so the upcoming run starts with a clean slate.
   * Set false in tests that don't want the side-effects.
   */
  pruneArtifacts?: boolean;
  /** Override for retention count. Defaults to env / 5. */
  retainRuns?: number;
  /** Override for the host base directory (testing). */
  hostBaseDir?: string;
}

/**
 * Pure: render the run-config JSON written to
 * `tests/e2e/.mcp-qa-run.json`. Keeps the shape identical to
 * what the reporter expects.
 */
export function renderRunConfigFile(
  runId: string | number,
  endpoint: string,
): string {
  const body = {
    runId: String(runId),
    endpoint,
    startedAt: new Date().toISOString(),
  };
  return JSON.stringify(body, null, 2);
}

/**
 * Run the restore pass. Caller passes a SandboxManager so the helper
 * stays free of singleton lookups in tests.
 *
 * v4.5: also handles retention pruning + sandbox dir wipes when
 * `pruneArtifacts` is true (default). Both side-effects are
 * best-effort — failures are logged but never block the restore.
 */
export async function restoreQaWorkspace(
  manager: Pick<
    SandboxManager,
    'writeWorkspaceFile' | 'readWorkspaceFile' | 'removeWorkspaceDirOnService'
  >,
  opts: RestoreOptions,
): Promise<WorkspaceRestoreReport> {
  const sessionKey = String(opts.sessionId);
  const port = opts.devServerPort ?? 5173;
  const report = emptyReport();

  if (opts.runConfig) {
    try {
      await manager.writeWorkspaceFile(
        sessionKey,
        'tests/e2e/.mcp-qa-run.json',
        renderRunConfigFile(opts.runConfig.runId, opts.runConfig.endpoint),
      );
      report.runConfigWritten = true;
    } catch (e) {
      report.warnings.push(
        `Failed to write tests/e2e/.mcp-qa-run.json: ${errMsg(e)}. Reporter will fall back to env vars.`,
      );
    }
  }

  try {
    await manager.writeWorkspaceFile(
      sessionKey,
      'tests/e2e/reporter.ts',
      REPORTER_TEMPLATE,
    );
    report.reporterRestored = true;
  } catch (e) {
    report.warnings.push(
      `Failed to restore tests/e2e/reporter.ts: ${errMsg(e)}. Streaming may be broken if the file was edited.`,
    );
  }

  try {
    await manager.writeWorkspaceFile(
      sessionKey,
      'tests/e2e/global-setup.ts',
      QA_GLOBAL_SETUP_TEMPLATE,
    );
    report.globalSetupRestored = true;
  } catch (e) {
    report.warnings.push(
      `Failed to restore tests/e2e/global-setup.ts: ${errMsg(e)}. Auth cookie may not be injected.`,
    );
  }

  // Validate the user-facing config and emit a recommended sibling
  // when drift is detected. Read failures (no sandbox / file absent)
  // are NOT warnings — the file just doesn't exist yet, which is fine.
  try {
    const cfg = await manager.readWorkspaceFile(sessionKey, 'playwright.config.ts');
    if (cfg) {
      const v = validatePlaywrightConfig(cfg);
      report.configRecommendations = v.recommendations;
      if (!v.ok) {
        report.configMissing = v.missing;
        try {
          await manager.writeWorkspaceFile(
            sessionKey,
            'playwright.config.recommended.ts',
            renderPlaywrightConfig(port),
          );
          report.configRecommendedWritten = true;
        } catch (e) {
          report.warnings.push(
            `Failed to write playwright.config.recommended.ts: ${errMsg(e)}.`,
          );
        }
      }
    }
  } catch (e) {
    report.warnings.push(`Could not read playwright.config.ts: ${errMsg(e)}.`);
  }

  // v4.5 retention + sandbox wipe. Default true; tests pass false.
  const pruneOn = opts.pruneArtifacts !== false;
  if (pruneOn) {
    const keep = opts.retainRuns ?? resolveRetainRuns();
    try {
      const pruned = await pruneOldRunDirs(opts.sessionId, keep, opts.hostBaseDir);
      report.prunedRunDirs = pruned.removed;
      for (const w of pruned.warnings) report.warnings.push(w);
    } catch (e) {
      report.warnings.push(`pruneOldRunDirs failed: ${errMsg(e)}`);
    }

    const wipeTargets = ['test-results', 'playwright-report'];
    for (const dir of wipeTargets) {
      try {
        await manager.removeWorkspaceDirOnService(sessionKey, undefined, dir);
        report.wipedSandboxDirs.push(dir);
      } catch (e) {
        report.warnings.push(`wipe ${dir} failed: ${errMsg(e)}`);
      }
    }
  }

  return report;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
