/**
 * Wire HumanInTheLoop + meta-bus listeners onto a subordinate's runner,
 * and read the final assistant message back when the run completes.
 *
 * Two flavors of wiring:
 *   - `wireSubordinateInterceptions` — accepts a full `RunCoderHandle`.
 *     Used after `runCoder()` returns. Idempotent.
 *   - `wireSubordinateInterceptionsForRunner` — accepts a bare runner,
 *     called from `runCoder({ onRunnerReady })` so an `ask_user` /
 *     `submit_plan` on turn 1 isn't silently dropped.
 *
 * Final-text reads live in `services/finalText.ts`; this module only owns
 * runner interception wiring.
 */
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { RunCoderHandle } from '@mcp/code-agent/index.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { IMetaBusWirer } from '@mcp/company/services/ports.js';

export interface SubordinateWireDeps {
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
}

/** Wire HitL + meta-bus listeners on a fully-formed handle. */
export function wireSubordinateInterceptions(
  handle: RunCoderHandle,
  agentRunId: string,
  role: string,
  deps: SubordinateWireDeps,
): void {
  deps.humanInLoop.wireSubordinatePlan(handle, agentRunId, role);
  deps.humanInLoop.wireSubordinateQuestion(handle, agentRunId, role);
  deps.humanInLoop.wireSubordinateTasks(handle, agentRunId, role);
  deps.wirer.wire(handle, role, agentRunId);
}

/**
 * Pre-turn wiring — fires from `runCoder({ onRunnerReady })` BEFORE
 * the runner takes its first turn. Critical for `submit_plan_to_master`
 * and similar tools called on turn 1.
 */
export function wireSubordinateInterceptionsForRunner(
  runner: CoderRunner,
  agentRunId: string,
  role: string,
  deps: SubordinateWireDeps,
): void {
  const synthetic = { runner } as unknown as RunCoderHandle;
  wireSubordinateInterceptions(synthetic, agentRunId, role, deps);
}
