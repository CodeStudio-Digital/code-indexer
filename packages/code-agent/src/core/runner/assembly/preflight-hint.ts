/**
 * Renders the `<preflight>` hint block from a task-preflight seed.
 *
 * Pure + deterministic (snapshot-testable). The block is injected into the
 * tail user message on turn 1 and re-injected after compaction (see
 * dynamic-injection.ts) — NEVER into the system prompt, so the cache-stable
 * static prefix is untouched.
 */
import type { PreflightSeed } from '@mcp/code-agent/index/types.js';

export function renderPreflightHint(seed: PreflightSeed): string {
  const lines: string[] = ['<preflight>'];

  if (seed.taskKind) {
    lines.push(`task_kind: ${seed.taskKind}`);
  }

  const toolsetParts: string[] = [];
  if (seed.profile) toolsetParts.push(`profile=${seed.profile}`);
  if (seed.pinTools?.length) toolsetParts.push(`prioritized: ${seed.pinTools.join(', ')}`);
  if (toolsetParts.length > 0) {
    lines.push(`toolset seeded for this task: ${toolsetParts.join('; ')}`);
  }

  if (seed.suggestedSkills?.length) {
    lines.push('skills that may fit this task — load the body BEFORE starting (get_skill_content({skill_id:"<id>"})):');
    for (const skill of seed.suggestedSkills) {
      lines.push(`- ${skill.id}${skill.reason ? ` — ${skill.reason}` : ''}`);
    }
  }

  if (seed.memories?.length) {
    lines.push('read these project memories BEFORE exploring (recall_memory({query:"<title>"})):');
    for (const memory of seed.memories) {
      lines.push(`- "${memory.title}"${memory.reason ? ` — ${memory.reason}` : ''}`);
    }
  }

  if (seed.agentDecisionGuidance) {
    const g = seed.agentDecisionGuidance;
    lines.push(`agent decision guidance: ${g.reminder}`);
    if (g.shouldAskBeforeAgentSwitch) {
      const from = g.currentAgent ?? 'unknown';
      const reason = g.agentSwitchReason ? ` — ${g.agentSwitchReason}` : '';
      lines.push(`agent switch: ask_user before switching ${from} → ${g.recommendedAgent}${reason}`);
    }
  }

  lines.push(
    'note: these are suggestions from a cheap pre-analysis run before any code was read. Verify against the code; ' +
      'if a memory conflicts with what you observe, trust the code (memories age when files change); ' +
      'find_tools / expand_toolset remain available if something is missing.',
  );
  lines.push('</preflight>');
  return lines.join('\n');
}
