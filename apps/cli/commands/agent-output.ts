import type { CoderRunner } from '@mcp/code-agent/core/runner.js';

type OutputWriter = (chunk: string) => void;

interface PendingGoalResult {
  name: string;
  content: string;
  durationMs: number;
}

interface SettledGoalMutation {
  ok: boolean;
  message?: string;
}

const GOAL_TOOLS = new Set(['create_goal', 'update_goal']);

function preview(content: string): string {
  const firstLines = content.split('\n').slice(0, 3).join('\n');
  return firstLines.length > 200 ? `${firstLines.slice(0, 200)}…` : firstLines;
}

/**
 * Render tool lifecycle output without treating a successful goal tool return
 * as durable. create_goal/update_goal remain provisional until runCoder emits
 * the corresponding persistence acknowledgement.
 */
export function wireAgentToolOutput(
  runner: CoderRunner,
  write: OutputWriter,
): void {
  const pendingGoals = new Map<string, PendingGoalResult>();
  const earlySettlements = new Map<string, SettledGoalMutation>();

  const renderGoalCommit = (goal: PendingGoalResult): void => {
    write(
      `  ✓ ${goal.name} committed (${goal.durationMs}ms) ${preview(goal.content)}\n\n`,
    );
  };

  const renderGoalFailure = (
    id: string,
    goal: PendingGoalResult | undefined,
    message: string,
  ): void => {
    const label = goal?.name ?? `goal mutation ${id}`;
    write(`  ✖ ${label} persistence failed: ${message}\n\n`);
  };

  runner.on('tool_call_result', (id, name, result, durationMs) => {
    if (result.isError || !GOAL_TOOLS.has(name)) {
      const prefix = result.isError ? '  ✖' : '  ✓';
      write(`${prefix} (${durationMs}ms) ${preview(result.content)}\n\n`);
      return;
    }

    const goal = { name, content: result.content, durationMs };
    const settlement = earlySettlements.get(id);
    if (settlement) {
      earlySettlements.delete(id);
      if (settlement.ok) renderGoalCommit(goal);
      else renderGoalFailure(id, goal, settlement.message ?? 'Goal state could not be persisted.');
      return;
    }

    pendingGoals.set(id, goal);
    write(
      `  … ${name} returned (${durationMs}ms); awaiting durable goal commit\n\n`,
    );
  });

  runner.on('goal_mutations_persisted', ({ toolUseIds }) => {
    for (const id of toolUseIds) {
      const goal = pendingGoals.get(id);
      if (!goal) {
        earlySettlements.set(id, { ok: true });
        continue;
      }
      pendingGoals.delete(id);
      renderGoalCommit(goal);
    }
  });

  runner.on('goal_mutations_persistence_failed', ({ toolUseIds, message }) => {
    for (const id of toolUseIds) {
      const goal = pendingGoals.get(id);
      if (!goal) {
        earlySettlements.set(id, { ok: false, message });
        continue;
      }
      pendingGoals.delete(id);
      renderGoalFailure(id, goal, message);
    }
  });
}
