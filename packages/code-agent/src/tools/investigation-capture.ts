/**
 * investigation-capture — auto-capture a finished sub-agent's digest into the
 * project-scoped investigation ledger (migration 126) so a later session can
 * `recall_investigations` it instead of re-running the same explore, and so
 * the `record_memo` trail gets a durable home.
 *
 * Extracted from spawn-agent.ts so the resume path can reuse it without
 * importing the whole spawn module. Best-effort; never throws. Skipped in
 * company sessions (they have the shared drive) and when the sub produced no
 * summary.
 */
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import type { MicroAgentCapability } from '@mcp/code-agent/tools/micro-agent-profiles.js';
import { getInvestigationEmbedder } from '@mcp/code-agent/tools/investigation-embedder.js';

export function captureInvestigation(
  deps: SubagentDeps,
  ctx: ToolContext,
  agent: { task: string; label: string; type: MicroAgentCapability },
  finalText: string,
  trail: string,
  tokens: number,
): void {
  if (ctx.companyContext) return;
  const sessionId = ctx.runner?.sessionId;
  if (!deps.sessionStore || sessionId == null || !finalText.trim()) return;
  try {
    const topic = agent.task.slice(0, 300);
    const summary = finalText.slice(0, 1000);
    const row = deps.sessionStore.recordInvestigation({
      session_id: sessionId,
      topic,
      summary,
      body: `${finalText}${trail}`.slice(0, 20000),
      source_label: agent.label,
      agent_type: agent.type,
      tokens,
    });
    // Live-update the Drive panel.
    ctx.runner?.emit('session_drive_changed', { kind: 'investigation' });
    // Semantic recall: embed the digest in the background (in-process only;
    // worker mode / no embedder → keyword recall still works). Fire-and-forget
    // so the spawn result isn't blocked on a network/CPU round-trip.
    const embed = getInvestigationEmbedder();
    if (embed) {
      void embed(`${topic}\n${summary}`)
        .then((vec) => {
          if (vec && vec.length > 0 && vec.some((x) => x !== 0)) {
            deps.sessionStore!.setInvestigationEmbedding(row.id, vec);
          }
        })
        .catch(() => { /* embedding is best-effort */ });
    }
  } catch (e) {
    console.warn(`[coder] captureInvestigation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
