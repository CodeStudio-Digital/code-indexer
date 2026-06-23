/**
 * Tag a synthesized harness refusal so it isn't miscounted as a tool error.
 * Loop guards, the permission gate and the timeout/abort paths REPLACE the
 * result with a refusal whose text LEADS with a stable marker. Real tool
 * failures and guard REMINDERS (prepended to a real result) stay NULL.
 *
 * This is the FALLBACK classifier — the dispatch pipeline now carries an
 * explicit `refusalKind` end-to-end (executing-dispatch.ts → tool_call_result
 * → persistAssistantTurn) and that value wins; the prefix match only covers
 * rows that arrive without it (legacy/subagent paths).
 *
 * Dependency-free on purpose: imported by BOTH the store (messages.ts) and
 * the dbWriter worker mirror (packages/indexer), which must classify
 * identically.
 */
export function classifyToolRefusal(resultText: string, isError: boolean): string | null {
  if (!isError || !resultText) return null;
  if (resultText.startsWith('[loop-refused')) return 'dedup';
  if (resultText.startsWith('[failure-streak REFUSED')) return 'failure-streak';
  if (resultText.startsWith('[user-denied')) return 'user_denied';
  if (resultText.startsWith('[tool-timeout:')) return 'timeout';
  if (resultText.startsWith('[tool-aborted:')) return 'abort';
  return null;
}
