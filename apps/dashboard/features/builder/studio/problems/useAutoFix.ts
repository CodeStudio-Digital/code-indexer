/**
 * Auto-fix loop for the Builder studio. When enabled (default ON), it
 * periodically asks the builder agent to resolve the newest unresolved
 * error in the problems feed — self-healing, V0-style.
 *
 * Anti-loop guards (all required, this is the loaded-gun part):
 *   - Per-signature attempt cap: stop auto-firing an error after N tries
 *     (it keeps reappearing → the agent can't fix it → hand back to human).
 *   - Agent-busy gate: never fire while the master is mid-turn / awaiting
 *     input (read from the shared store, written by the chat pane).
 *   - Global cooldown: one auto-fire at a time, with breathing room so the
 *     agent's edit + HMR can settle before the next evaluation.
 *   - Console warnings are never auto-fixed — only real runtime/network
 *     errors.
 */
import { useEffect, useRef, useState } from 'react';
import { formatProblem, isAgentBusy, requestStudioSend } from '../studio-context-store.js';
import type { Problem } from './usePreviewProblems.js';

const MAX_ATTEMPTS = 3;
const COOLDOWN_MS = 12_000;
const TICK_MS = 2_000;
const STORAGE_KEY = 'mcp.studio.autofix';

function readEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === 'true'; // default ON
  } catch {
    return true;
  }
}

export function useAutoFix(sessionId: number, problems: Problem[]) {
  const [enabled, setEnabledState] = useState(readEnabled);
  const attempts = useRef<Map<string, number>>(new Map());
  const lastFireAt = useRef(0);

  function setEnabled(v: boolean) {
    setEnabledState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const candidates = problems.filter((p) => p.kind !== 'console');
      if (candidates.length === 0) return;
      if (isAgentBusy(sessionId)) return;
      const now = Date.now();
      if (now - lastFireAt.current < COOLDOWN_MS) return;
      // Newest candidate that hasn't exhausted its attempts.
      const target = [...candidates]
        .reverse()
        .find((p) => (attempts.current.get(p.signature) ?? 0) < MAX_ATTEMPTS);
      if (!target) return;
      attempts.current.set(target.signature, (attempts.current.get(target.signature) ?? 0) + 1);
      lastFireAt.current = now;
      requestStudioSend(
        sessionId,
        `Auto-fix: resolve this error, then confirm the preview compiles.\n\n${formatProblem(target.raw)}`,
      );
    };
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [enabled, problems, sessionId]);

  return { autoFixEnabled: enabled, setAutoFixEnabled: setEnabled };
}
