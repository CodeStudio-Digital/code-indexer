/**
 * Auto-fix loop for the Builder studio. When enabled (default ON), it asks
 * the builder agent to resolve preview errors — self-healing, V0-style —
 * but ONLY while the agent is idle. Errors captured mid-run never fire
 * (the agent's own edits keep resurfacing them via HMR); instead, at the
 * busy→idle edge the container reloads the preview once (`onRevalidate`)
 * and only errors that re-emit after that reload — still real in the final
 * state — fire a single auto-fix message.
 *
 * The decision rules (suspect watermark, freshness, attempt cap, cooldown,
 * console exclusion) live in autofix-policy.ts as a pure function; this
 * hook owns the React wiring and the mutable counters. The busy signal is
 * published by the chat pane (usePublishAgentBusy in AgentChat for the
 * single-session/DS path, CompanySessionView for the company path).
 */
import { useEffect, useRef, useState } from 'react';
import { formatProblem, isAgentBusy, requestStudioSend } from '../studio-context-store.js';
import { decideAutoFix, TICK_MS } from './autofix-policy.js';
import type { Problem } from './usePreviewProblems.js';

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

export interface AutoFixOptions {
  /**
   * Reload the preview so errors that still exist re-emit fresh (run-end
   * revalidation). Without it, run-end suspects simply never fire.
   */
  onRevalidate?: () => void;
}

export function useAutoFix(sessionId: number, problems: Problem[], opts?: AutoFixOptions) {
  const [enabled, setEnabledState] = useState(readEnabled);
  const attempts = useRef<Map<string, number>>(new Map());
  // Warm-up: pretend we just fired, so a freshly mounted pane (dashboard
  // reload mid-run → busy publishes a beat late) can't fire instantly.
  const lastFireAt = useRef(Date.now());
  const prevBusy = useRef(false);
  // Watermark: only problems (re-)emitted after this instant may fire. It
  // advances at every busy→idle edge, marking everything captured during
  // the run as suspect until the revalidation reload proves it survives.
  const suspectBefore = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

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
      const now = Date.now();
      const busyNow = isAgentBusy(sessionId);
      const decision = decideAutoFix({
        problems,
        attempts: attempts.current,
        busyNow,
        prevBusy: prevBusy.current,
        suspectBefore: suspectBefore.current,
        lastFireAt: lastFireAt.current,
        now,
      });
      prevBusy.current = busyNow;
      if (decision.kind === 'edge') {
        suspectBefore.current = now;
        if (decision.revalidate) optsRef.current?.onRevalidate?.();
        return;
      }
      if (decision.kind !== 'fire') return;
      const target = decision.target;
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
