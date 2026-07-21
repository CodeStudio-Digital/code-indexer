/**
 * spawn-agent-render — shared result renderers for spawn_agent and its
 * async siblings (collect_agents / resume_agent).
 *
 * Extracted from spawn-agent.ts so the blocking path, the background
 * collect path and the resume path emit byte-identical aggregation text.
 * The dashboard parses these headers back out of persisted history
 * (MessageView.parsePersistedAgentsGroup) — change formats there and here
 * together.
 *
 * Optional tokens (`spawn=`, `group=`, `attempt=`) are rendered only when
 * provided, so legacy callers keep producing the exact legacy bytes.
 */
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import { renderCollectedSnapshotForParent } from '@mcp/code-agent/tools/subagent-collector.js';
import { emptyCollected, type SubagentCollected } from '@mcp/code-agent/tools/implement-subagent.js';

export interface ProviderLabel {
  provider: string;
  model: string;
}

export interface RenderableAgentResult {
  label: string;
  /** Capability id shown as `type=` in the per-agent meta line. */
  type: string;
  reason: string;
  toolCallCount: number;
  usage: ChatUsage;
  finalText: string;
  collected?: SubagentCollected;
  /** Rendered as ` attempt=N` only when >= 2 (resume results). */
  attempt?: number;
  /** Hard tool-call cap in effect for the run. Rendered as ` max_tools=M` only
   *  when > 0, so unlimited runs keep producing the exact legacy bytes. */
  maxToolCalls?: number;
  /** 0-based original roster index for the "### Agent N" heading. Defaults to
   *  the array position — resume passes the ORIGINAL index so a partial
   *  relaunch doesn't renumber (which would let the model target wrong). */
  displayIndex?: number;
}

/** Frente C — structured trail (memos/snapshots/board). '' when empty. */
export function renderTrail(collected?: SubagentCollected): string {
  return renderCollectedSnapshotForParent(collected ?? emptyCollected());
}

export function renderSingleHeader(
  info: ProviderLabel,
  type: string,
  reason: string,
  usage: ChatUsage,
  spawnId?: string,
  maxToolCalls?: number,
): string {
  const cached = usage.cache_read_input_tokens ?? 0;
  const spawnTok = spawnId ? ` spawn=${spawnId}` : '';
  const maxTok = maxToolCalls && maxToolCalls > 0 ? ` max_tools=${maxToolCalls}` : '';
  return (
    `[subagent provider=${info.provider} model=${info.model} type=${type} ` +
    `reason=${reason} input=${usage.input_tokens} output=${usage.output_tokens} cache_hit=${cached}${spawnTok}${maxTok}]\n\n`
  );
}

export function renderSingleBody(finalText: string, reason: string): string {
  return finalText
    || `(subagent did not produce a final summary — reason=${reason}. Retry with narrower scope or investigate directly.)`;
}

export function renderParallelHeader(
  count: number,
  info: ProviderLabel,
  totalUsage: ChatUsage,
  groupId?: string,
): string {
  const cached = totalUsage.cache_read_input_tokens ?? 0;
  const groupTok = groupId ? `group=${groupId}, ` : '';
  return (
    `[parallel agents: ${count} agents, ${groupTok}provider=${info.provider} model=${info.model}, ` +
    `input=${totalUsage.input_tokens} output=${totalUsage.output_tokens} cache_hit=${cached}]\n\n`
  );
}

export function renderAgentSection(index: number, r: RenderableAgentResult): string {
  const attemptTok = r.attempt != null && r.attempt >= 2 ? ` attempt=${r.attempt}` : '';
  const maxTok = r.maxToolCalls && r.maxToolCalls > 0 ? ` max_tools=${r.maxToolCalls}` : '';
  const meta =
    `[type=${r.type} reason=${r.reason} ` +
    `tools=${r.toolCallCount} input=${r.usage.input_tokens} output=${r.usage.output_tokens}${attemptTok}${maxTok}]`;
  const text = r.finalText || '(no summary produced)';
  const trail = renderTrail(r.collected);
  const n = (r.displayIndex ?? index) + 1;
  return `### Agent ${n}: ${r.label}\n${meta}\n${text}${trail}`;
}

export function renderParallelBody(results: RenderableAgentResult[]): string {
  return results.map((r, i) => renderAgentSection(i, r)).join('\n\n---\n\n');
}

/**
 * Footer appended to spawn/resume results that contain failed agents —
 * the in-context discovery path for `resume_agent` (the spawn_agent schema
 * itself stays untouched).
 */
export function renderResumeHint(spawnId: string, failedCount: number): string {
  const noun = failedCount === 1 ? 'agent' : 'agents';
  return (
    `\n\n---\n\n[${failedCount} ${noun} did not complete. To retry them keeping their progress: ` +
    `resume_agent({spawn_id:"${spawnId}"}). Add \`guidance\` if you know what went wrong. ` +
    `Do NOT re-spawn the same tasks from scratch.]`
  );
}
