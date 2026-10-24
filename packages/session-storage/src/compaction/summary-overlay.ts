import type { CompactionSummaryV3, CompactionLiveStateV3 } from './summary-types.js';
import { capCompactionSummaryV3 } from './summary-codec.js';

function formatGoal(goal: CompactionLiveStateV3['goal']): string | undefined {
  if (!goal) return undefined;
  if (typeof goal === 'string') return goal;
  return goal.status ? `${goal.text} (status=${goal.status})` : goal.text;
}

/** Persisted tasks are the source of truth; model inference is used only when absent. */
export function overlayLiveStateV3(
  summary: CompactionSummaryV3,
  liveState?: CompactionLiveStateV3 | null,
): CompactionSummaryV3 {
  if (!liveState) return summary;
  let structuredTasks: string[] | undefined;
  if (liveState.todos !== undefined) {
    structuredTasks = liveState.todos
      .filter((todo) => todo.status === 'pending' || todo.status === 'in_progress')
      .map((todo) => `[${todo.status}] ${todo.content}`);
  } else if (liveState.plan !== undefined) {
    structuredTasks = liveState.plan
      .filter((item) => item.status === 'pending' || item.status === 'in_progress')
      .map((item) => `[${item.status}] ${item.step ?? item.content ?? ''}`.trim())
      .filter(Boolean);
  }
  const goal = formatGoal(liveState.goal);
  const activePlan = formatGoal(liveState.activePlan);
  return capCompactionSummaryV3({
    ...summary,
    resume: {
      ...summary.resume,
      ...(structuredTasks !== undefined ? {
        pending_tasks: structuredTasks,
        next_step: structuredTasks.find((task) => task.startsWith('[in_progress]'))
          ?? structuredTasks[0]
          ?? '',
      } : {}),
      ...(goal ? { active_goal: goal } : {}),
      ...(activePlan ? {
        constraints: [
          ...summary.resume.constraints,
          `Persisted active plan: ${activePlan}`,
        ],
      } : {}),
    },
  });
}
