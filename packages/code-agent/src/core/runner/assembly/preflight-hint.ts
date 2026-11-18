/**
 * Renders the `<preflight>` hint block from a task-preflight seed.
 *
 * Pure + deterministic (snapshot-testable). The block is injected into the
 * tail user message on turn 1 and re-injected after compaction (see
 * dynamic-injection.ts) — NEVER into the system prompt, so the cache-stable
 * static prefix is untouched.
 */
import type { PreflightSeed } from '@mcp/code-agent/index/types.js';

export interface RenderPreflightOptions {
  /** When false, suppress the bugfix reproduction-first workflow block. */
  bugWorkflow?: boolean;
}

export function renderPreflightHint(
  seed: PreflightSeed,
  options: RenderPreflightOptions = {},
): string {
  const lines: string[] = ['<preflight>'];

  if (seed.taskKind) {
    lines.push(`task_kind: ${seed.taskKind}`);
    if (seed.taskKind === 'bugfix' && options.bugWorkflow !== false) {
      lines.push(
        'bug_workflow: reproduce the defect BEFORE touching production code. ' +
          '1) build a reproduction that fails for the expected reason; ' +
          '2) find the root cause with evidence; ' +
          '3) make the smallest fix; ' +
          '4) confirm the reproduction now passes and the previously-passing tests still pass; ' +
          '5) check boundary and negative cases. ' +
          'When a unit test is not viable, a sanitized captured request, fixture, replay, script, browser scenario, integration test or benchmark is an acceptable oracle.',
      );
    }
  }

  // Preflight guesses cannot promise membership in the final provider catalog.
  // Keep the raw recommendations in telemetry, not as misleading tool aliases
  // in the prompt (e.g. run_command when exec_command/write_stdin own execution).
  if (seed.profile) lines.push(`profile=${seed.profile}; use the visible tool schemas as the invocation contract.`);

  if (seed.targetProjects?.length) {
    lines.push('likely linked projects — verify before editing:');
    for (const project of seed.targetProjects) {
      lines.push(`- ${project.slug}${project.reason ? ` — ${project.reason}` : ''}`);
    }
  }

  if (seed.suggestedSkills?.length) {
    lines.push('skills with objective applicability evidence — confirm the target project before loading:');
    for (const skill of seed.suggestedSkills) {
      const evidence = skill.evidence ? ` [evidence=${skill.evidence}]` : '';
      lines.push(`- ${skill.id}${evidence}${skill.reason ? ` — ${skill.reason}` : ''}`);
    }
  }

  if (seed.memories?.length) {
    lines.push('read these project memories BEFORE exploring (recall_memory({query:"<title>"})):');
    for (const memory of seed.memories) {
      const project = memory.projectSlug ? `[${memory.projectSlug}] ` : '';
      lines.push(`- ${project}"${memory.title}"${memory.reason ? ` — ${memory.reason}` : ''}`);
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
      'use visible tools first and find_tools for a missing capability.',
  );
  lines.push('</preflight>');
  return lines.join('\n');
}
