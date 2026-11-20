/**
 * What the parent's worker does with the child-agent results it receives, on
 * the wait path (a tool's claim) and on the background path (the sweep at run
 * start and at turn boundaries): count their usage once (ChildAgentUsageLedger)
 * and make the files the child changed read fresh in the parent, as after the
 * parent's own edit: the overlay marks them and their index entry is
 * refreshed. The parent's file knowledge is left as it is, so the overwrite
 * guard still refuses a blind overwrite of a file the child changed after the
 * parent read it.
 */
import type { ToolContext, ToolResult } from '../core/tool.js';
import { resolveWorkspacePath } from '../tools/paths.js';
import type { ChildAgentRunUsage, ChildAgentUsageLedger } from './child-agent-usage.js';
import { captureChildInvestigations, type ChildInvestigationDeps } from './child-agent-investigations.js';

/** The incremental index refresh runCoder runs after the parent's own edits. */
export type ChildChangeReindex = (projectId: number, relPath: string, absPath: string) => Promise<void>;

/** Marks the files a child changed in the parent's overlays and refreshes their index; returns the marked paths. */
export function markChildAgentChanges(ctx: ToolContext, changedFiles: readonly string[], reindex?: ChildChangeReindex): string[] {
  const marked: string[] = [];
  for (const file of changedFiles) {
    // A child inherits its parent's project and worktree, so its paths resolve the same way.
    const resolved = resolveWorkspacePath(file, ctx, 'write');
    if (!resolved.ok || resolved.external) continue;
    const relPath = resolved.relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!relPath || relPath === '.') continue;
    const overlay = resolved.projectId != null ? ctx.overlayByRoot?.get(resolved.projectId) ?? ctx.overlay : ctx.overlay;
    overlay?.mark(relPath);
    marked.push(relPath);
    if (resolved.projectId != null && reindex) {
      void reindex(resolved.projectId, relPath, resolved.abs).catch(() => undefined); // best effort, like own edits
    }
  }
  return marked;
}

export interface ChildAgentAccounting {
  /**
   * For a tool that received child results in this turn: their usage and run
   * keys, counted once, to return as ToolResult.subUsage / subUsageRuns.
   */
  claim(childIds: readonly string[]): Promise<Pick<ToolResult, 'subUsage' | 'subUsageRuns'>>;
  /** Counts what arrived outside a tool (background, restart, late descendants) as standalone usage. */
  sweep(): Promise<ChildAgentRunUsage[]>;
}

export function createChildAgentAccounting(input: {
  ledger: Pick<ChildAgentUsageLedger, 'claimForTurn' | 'sweep'>;
  toolContext: ToolContext;
  reindex?: ChildChangeReindex;
  /** With child chats: received conclusions go to the investigation ledger. */
  investigations?: ChildInvestigationDeps;
}): ChildAgentAccounting {
  const absorb = async (runs: readonly ChildAgentRunUsage[]) => {
    for (const run of runs) markChildAgentChanges(input.toolContext, run.changedFiles, input.reindex);
    if (input.investigations && runs.length > 0) await captureChildInvestigations(input.investigations, input.toolContext, runs);
  };
  return {
    async claim(childIds) {
      const claim = await input.ledger.claimForTurn(childIds);
      await absorb(claim.runs);
      return claim.usage ? { subUsage: claim.usage, subUsageRuns: claim.keys } : {};
    },
    async sweep() {
      const runs = await input.ledger.sweep();
      await absorb(runs);
      return runs;
    },
  };
}
