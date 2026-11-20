/**
 * A child chat's concluded run, once its parent receives it, goes into the
 * project's investigation ledger, as spawn_agent's results did
 * (captureInvestigation: outside Company, a non-empty final answer, every
 * profile, recorded with its capability). The run is the one the usage ledger
 * counts for the first time (a tool's claim or the sweep), so it is captured
 * once. Only the parent's own children: a grandchild's conclusion is captured
 * by the child that received it. Recorded states: completed, and cut_off
 * (its salvage summary, like the retired spawn_agent's watchdog stop); a failed or
 * aborted run is not an investigation result.
 */
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { ToolContext } from '../core/tool.js';
import { captureInvestigation } from '../tools/investigation-capture.js';
import { MICRO_AGENT_PROFILES, resolveMicroAgentProfile } from '../tools/micro-agent-profiles.js';
import type { ChildAgentRunUsage } from './child-agent-usage.js';

export interface ChildInvestigationDeps {
  parentId: string;
  sessions: Pick<FsSessionStore, 'getChildAgentSession' | 'getSession' | 'recordInvestigation'>;
}

const RECORDED: ReadonlySet<string> = new Set(['completed', 'cut_off']);
const sameId = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** Captures the received conclusions of the parent's own children; returns how many it recorded. */
export async function captureChildInvestigations(deps: ChildInvestigationDeps, ctx: ToolContext,
  runs: readonly ChildAgentRunUsage[]): Promise<number> {
  let captured = 0;
  for (const run of runs) {
    try {
      const child = await deps.sessions.getChildAgentSession(run.childId);
      const done = child?.conclusion;
      if (!child || !done || done.run_id !== run.runId || !RECORDED.has(done.state) || !done.final_text?.trim()) continue;
      if (!sameId(child.parent_session_id, deps.parentId)) continue;
      const profile = resolveMicroAgentProfile(child.profile ?? '') ?? MICRO_AGENT_PROFILES.explore;
      const title = (await deps.sessions.getSession(child.id))?.title?.trim() || profile.defaultLabel;
      await captureInvestigation({ sessionStore: deps.sessions }, ctx, { task: title, label: title, type: profile.capability },
        done.final_text, '', done.usage.input_tokens + done.usage.output_tokens);
      captured++;
    } catch (error) {
      console.warn(`[child-agent] investigation capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return captured;
}
