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
 * `readFinalAssistantText` opens the agent's coder session store and
 * returns the most recent assistant text block. Best-effort: silent
 * failure returns `null` — the completion path stays usable even when
 * the store is unreachable.
 */
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { RunCoderHandle } from '@mcp/code-agent/index.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { IMetaBusWirer } from '@mcp/company/services/ports.js';

export interface SubordinateWireDeps {
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
}

/** Wire HitL + meta-bus listeners on a fully-formed handle. */
export function wireSubordinateInterceptions(
  handle: RunCoderHandle,
  agentRunId: number,
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
  agentRunId: number,
  role: string,
  deps: SubordinateWireDeps,
): void {
  const synthetic = { runner } as unknown as RunCoderHandle;
  wireSubordinateInterceptions(synthetic, agentRunId, role, deps);
}

/**
 * Read the last assistant text block from the agent's session.
 *
 * Opens a fresh `SessionStore` (each call is its own connection) and
 * tails the last 3 messages so most "completion message" lookups stay
 * cheap. Returns `null` when the store is unreachable, the tail is
 * empty, or no assistant message has any text blocks.
 */
export function readFinalAssistantText(sessionId: number): string | null {
  try {
    const config = loadConfig();
    const store = new SessionStore(config.dbPath);
    try {
      const loaded = store.loadSessionMessagesTail(sessionId, 3);
      if (!loaded) return null;
      for (let i = loaded.messages.length - 1; i >= 0; i--) {
        const msg = loaded.messages[i];
        if (msg.role !== 'assistant') continue;
        const text = msg.content
          .filter((b): b is { type: 'text'; text: string } =>
            (b as { type?: string }).type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text) return text;
      }
      return null;
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}
