import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BundlePlan } from './model.js';
import { legacySandboxArchiveDir } from './legacy-paths.js';

export interface LegacyCleanupReport {
  removedFiles: number;
  removedDirectories: number;
  skipped: string[];
}

function assertInside(base: string, target: string): void {
  const rel = relative(resolve(base), resolve(target));
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`legacy cleanup target escapes base: base=${base} target=${target}`);
  }
}

function removeTreeWithoutFollowingLinks(
  base: string,
  target: string,
  report: LegacyCleanupReport,
): void {
  if (!existsSync(target)) return;
  assertInside(base, target);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    unlinkSync(target);
    report.removedFiles += 1;
    return;
  }
  if (stat.isFile()) {
    unlinkSync(target);
    report.removedFiles += 1;
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`unsupported legacy cleanup entry: ${target}`);
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    removeTreeWithoutFollowingLinks(base, join(target, entry.name), report);
  }
  rmdirSync(target);
  report.removedDirectories += 1;
}

function removeMatchingRuntimeLogs(
  base: string,
  sessionId: string,
  report: LegacyCleanupReport,
): void {
  if (!existsSync(base)) return;
  const matcher = new RegExp(`^${sessionId}(?:\\.\\d+)?\\.jsonl$`);
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isFile() || !matcher.test(entry.name)) continue;
    removeTreeWithoutFollowingLinks(base, join(base, entry.name), report);
  }
}

/**
 * Called only after DB swap + bundle smoke. Every target is anchored under an
 * explicit legacy base and links/junctions are unlinked rather than traversed.
 */
export function cleanupLegacySessionSideStores(
  dataDir: string,
  plans: readonly BundlePlan[],
  migrationRunDir: string,
  sourceDbPath?: string,
): LegacyCleanupReport {
  const report: LegacyCleanupReport = {
    removedFiles: 0,
    removedDirectories: 0,
    skipped: [],
  };
  const centralOutputs = join(dataDir, 'coder-tool-outputs');
  const transcripts = process.env.MCP_SUBAGENT_TRANSCRIPT_DIR?.trim()
    || join(dataDir, 'subagent-transcripts');
  const runtimeLogs = join(process.cwd(), '.mcp-indexer', 'runtime-event-logs', 'coder');
  const sandboxArchives = legacySandboxArchiveDir(dataDir);
  const companyDrives = join(dataDir, 'company-drives');

  for (const plan of plans) {
    const legacyId = String(plan.identity.id);
    if (plan.identity.kind === 'coder') {
      removeTreeWithoutFollowingLinks(centralOutputs, join(centralOutputs, legacyId), report);
      removeTreeWithoutFollowingLinks(transcripts, join(transcripts, legacyId), report);
      removeMatchingRuntimeLogs(runtimeLogs, legacyId, report);
      if (plan.projectRoot) {
        const projectOutputs = join(plan.projectRoot, '.mcp-indexer', 'coder', 'tool-outputs');
        removeTreeWithoutFollowingLinks(projectOutputs, join(projectOutputs, legacyId), report);
      }
    }
    if (plan.identity.kind === 'company') {
      removeTreeWithoutFollowingLinks(
        companyDrives,
        join(companyDrives, `ses_${legacyId}`),
        report,
      );
      removeTreeWithoutFollowingLinks(
        sandboxArchives,
        join(sandboxArchives, `${legacyId}.tar`),
        report,
      );
    }
  }

  if (sourceDbPath) {
    const preSplitBackup = `${resolve(sourceDbPath)}.pre-split.bak`;
    removeTreeWithoutFollowingLinks(dirname(preSplitBackup), preSplitBackup, report);
    removeTreeWithoutFollowingLinks(
      dirname(preSplitBackup),
      `${preSplitBackup}.meta.json`,
      report,
    );
  }

  removeTreeWithoutFollowingLinks(dirname(migrationRunDir), migrationRunDir, report);
  return report;
}
