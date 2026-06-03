/**
 * Collects runtime/network/console problems forwarded from the preview
 * iframe into a deduped, capped ring buffer. Build/compile errors already
 * arrive through the dev-server log (and as `mcp:runtime-error` via the
 * Vite HMR `vite:error` hook), so this single feed unifies them.
 *
 * Auto-fix (Phase 1.5) builds on top of this; Phase 1 exposes the list +
 * a manual "fix" affordance via the ProblemsBadge.
 */
import { useCallback, useRef, useState } from 'react';
import type { ProblemMessage } from '../studio-context-store.js';

export interface Problem extends Record<string, unknown> {
  id: string;
  kind: 'runtime' | 'network' | 'console';
  signature: string;
  ts: number;
  /** The original message, for formatting into an agent prompt. */
  raw: ProblemMessage;
  /** Short human label for the badge list. */
  label: string;
}

const MAX = 50;

function signatureOf(m: ProblemMessage): string {
  if (m.type === 'mcp:network') return `net|${m.method}|${m.url}|${m.status}`;
  if (m.type === 'mcp:runtime-error') return `err|${m.message.slice(0, 160)}`;
  return `con|${m.level}|${m.message.slice(0, 160)}`;
}

function labelOf(m: ProblemMessage): string {
  if (m.type === 'mcp:network') return `${m.status} ${m.method} ${m.url}`.slice(0, 120);
  if (m.type === 'mcp:runtime-error') return m.message.slice(0, 120);
  return `${m.level}: ${m.message}`.slice(0, 120);
}

export function usePreviewProblems() {
  const [problems, setProblems] = useState<Problem[]>([]);
  const seen = useRef<Map<string, number>>(new Map());

  const add = useCallback((m: ProblemMessage) => {
    const signature = signatureOf(m);
    const now = m.ts || Date.now();
    const last = seen.current.get(signature) ?? 0;
    if (now - last < 2000) return; // throttle identical signatures
    seen.current.set(signature, now);
    const kind = m.type === 'mcp:network' ? 'network' : m.type === 'mcp:console' ? 'console' : 'runtime';
    const problem: Problem = {
      id: `${signature}|${now}`,
      kind,
      signature,
      ts: now,
      raw: m,
      label: labelOf(m),
    };
    setProblems((prev) => {
      // Replace a same-signature entry (keep newest) and cap the buffer.
      const filtered = prev.filter((p) => p.signature !== signature);
      return [...filtered, problem].slice(-MAX);
    });
  }, []);

  const clear = useCallback(() => {
    setProblems([]);
    seen.current.clear();
  }, []);

  const dismiss = useCallback((id: string) => {
    setProblems((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const errorCount = problems.filter((p) => p.kind !== 'console').length;
  return { problems, add, clear, dismiss, errorCount };
}
