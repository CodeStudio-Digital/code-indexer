/**
 * transcript-repair — provider-safety passes over a message history:
 *
 *   1. Drop orphaned tool_result blocks whose tool_use is gone
 *      (→ provider 400 "No tool call found for function call output").
 *   2. Inject synthetic `is_error` tool_results for orphaned tool_use
 *      blocks (→ provider 400 "No tool output found for function call").
 *   3. Merge consecutive same-role messages (strict-alternation providers,
 *      e.g. GLM error 1214).
 *
 * Extracted verbatim from `compactHistoryForLLM` (core/runner.ts) so the
 * subagent resume path can sanitize captured transcripts with the exact
 * same battle-tested logic. `compactHistoryForLLM` delegates here — one
 * implementation, two call sites. The function is pure w.r.t. its input
 * (never mutates `messages` or its elements) and idempotent: repairing an
 * already-repaired history returns structurally identical output.
 */
import type { AgentMessage } from './messages.js';

const DEFAULT_NOTE = (name: string): string =>
  `[Session interrupted — tool "${name}" was running when the session ended. Result was not captured.]`;

export function repairToolPairing(
  messages: AgentMessage[],
  noteFor: (toolName: string) => string = DEFAULT_NOTE,
): AgentMessage[] {
  // Safety net: remove orphaned tool_results whose tool_use was dropped
  // (e.g. by a prior summarizer splice). Without this, the provider rejects
  // the request with "400 No tool call found for function call output".
  const knownToolUseIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') knownToolUseIds.add(b.id);
    }
  }
  let orphanCount = 0;
  const sanitized = messages.map((m): AgentMessage | null => {
    if (m.role !== 'tool') return m;
    const filtered = m.content.filter((b) => {
      if (b.type !== 'tool_result') return true;
      const tid = (b as { tool_use_id?: string }).tool_use_id;
      if (tid && !knownToolUseIds.has(tid)) {
        orphanCount++;
        return false;
      }
      return true;
    });
    if (filtered.length === 0) return null;
    if (filtered.length === m.content.length) return m;
    return { ...m, content: filtered };
  }).filter((m): m is AgentMessage => m !== null);

  if (orphanCount > 0) {
    console.warn(
      `[coder] sanitized ${orphanCount} orphaned tool_result block(s) ` +
      `whose tool_use was removed by summarization`,
    );
  }

  // Safety net 2: inject synthetic tool_result for orphaned tool_use blocks
  // (tool_use exists in assistant message but no matching tool_result in any
  // tool message). This happens when the runner crashes/aborts between
  // persisting the assistant message and persisting the tool result message.
  // Without this, the provider rejects with
  // "400 No tool output found for function call".
  const knownToolResultIds = new Set<string>();
  for (const m of sanitized) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const tid = (b as { tool_use_id?: string }).tool_use_id;
        if (tid) knownToolResultIds.add(tid);
      }
    }
  }

  let syntheticCount = 0;
  const patched: AgentMessage[] = [];
  for (let i = 0; i < sanitized.length; i++) {
    const m = sanitized[i];
    patched.push(m);
    if (m.role !== 'assistant') continue;

    const orphanedToolUses: Array<{ id: string; name: string }> = [];
    for (const b of m.content) {
      if (b.type === 'tool_use' && !knownToolResultIds.has(b.id)) {
        orphanedToolUses.push({ id: b.id, name: b.name });
      }
    }
    if (orphanedToolUses.length === 0) continue;

    // Check if the very next message is already a tool message that covers
    // some of these IDs (partial coverage). Only inject for truly missing ones.
    const next = sanitized[i + 1];
    if (next?.role === 'tool') {
      const coveredIds = new Set<string>();
      for (const b of next.content) {
        if (b.type === 'tool_result') {
          const tid = (b as { tool_use_id?: string }).tool_use_id;
          if (tid) coveredIds.add(tid);
        }
      }
      const stillOrphaned = orphanedToolUses.filter((tu) => !coveredIds.has(tu.id));
      if (stillOrphaned.length === 0) continue;

      // Merge synthetic results into the existing tool message
      const syntheticResults = stillOrphaned.map((tu) => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: noteFor(tu.name),
        is_error: true,
      }));
      // Replace next message with merged version
      sanitized[i + 1] = { ...next, content: [...next.content, ...syntheticResults] };
      syntheticCount += stillOrphaned.length;
    } else {
      // No tool message follows — inject a new one
      const syntheticResults = orphanedToolUses.map((tu) => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: noteFor(tu.name),
        is_error: true,
      }));
      patched.push({ role: 'tool' as const, content: syntheticResults });
      syntheticCount += orphanedToolUses.length;
    }
  }

  const resultArray = syntheticCount > 0 ? patched : sanitized;

  // Merge consecutive same-role messages to avoid 400 "The messages parameter
  // is illegal" from providers that strictly require alternating turns.
  // User merges: classic Anthropic requirement.
  // Assistant merges: happens after summarizer splice when the synthetic
  // assistant is followed by an original assistant (GLM error 1214).
  const merged: AgentMessage[] = [];
  for (const m of resultArray) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'user' && m.role === 'user') {
      last.content = [...last.content, ...m.content];
    } else if (last && last.role === 'assistant' && m.role === 'assistant') {
      last.content = [...last.content, ...m.content];
    } else {
      merged.push({ ...m, content: [...m.content] });
    }
  }

  if (syntheticCount > 0) {
    console.warn(
      `[coder] injected ${syntheticCount} synthetic tool_result(s) for orphaned ` +
      `tool_use blocks (session was interrupted mid-tool-execution)`,
    );
  }

  return merged;
}
