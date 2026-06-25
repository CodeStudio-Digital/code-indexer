import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { estimateMessageTokens } from '@mcp/code-agent/core/token-accounting.js';
import { messageChars } from './char-counts.js';
import { PRUNE_PROTECT } from './limits.js';

/**
 * Determine the cutoff index: the smallest index `i` such that the combined
 * size of `messages[i..]` is ≤ `protect`. Messages strictly before this index
 * are candidates for compaction.
 */
export function computeCutoffIndex(messages: AgentMessage[], protect = PRUNE_PROTECT): number {
  let running = 0;
  // Walk from tail toward head, growing the protected tail.
  for (let i = messages.length - 1; i >= 0; i--) {
    running += messageChars(messages[i]);
    if (running > protect) {
      // messages[i] pushed us over the budget — everything BEFORE i is
      // compactable, i itself stays.
      return i + 1;
    }
  }
  // Entire history fits under the protect budget.
  return 0;
}

/**
 * Token-based cutoff: walk from the tail and keep messages until their
 * combined token estimate exceeds `protectTokens`. The first index whose
 * INCLUSION would push us over the budget is the cutoff — everything strictly
 * before is compactable, everything from cutoff onward stays verbatim.
 *
 * Returns 0 if the entire history fits under the budget (no compaction needed).
 */
export function computeCutoffIndexByTokens(messages: AgentMessage[], protectTokens: number): number {
  let running = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    running += estimateMessageTokens(messages[i]);
    if (running > protectTokens) return i + 1;
  }
  return 0;
}

/**
 * Atomic-pair-preserving cutoff: ensure no `tool_result` whose paired
 * `tool_use` lives in the compactable prefix survives in the kept tail (the
 * provider rejects orphaned tool_results with 400 "No tool call found").
 * Symmetric for `tool_use` blocks in the tail whose `tool_result` is in the
 * prefix.
 *
 * In practice the sane outcome is almost always: never split a pair — recede
 * the cutoff to include both halves. We only advance when receding would push
 * us above the protect budget, in which case we accept losing that one pair.
 */
export function snapCutoffPreservingPairs(messages: AgentMessage[], cutoff: number): number {
  if (cutoff <= 0 || cutoff >= messages.length) return cutoff;

  interface PairRef { useMsg: number; resultMsg: number | null; }
  const pairs = new Map<string, PairRef>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          const id = (b as { id: string }).id;
          if (!pairs.has(id)) pairs.set(id, { useMsg: i, resultMsg: null });
          else pairs.get(id)!.useMsg = i;
        }
      }
    } else if (m.role === 'tool') {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const id = (b as { tool_use_id?: string }).tool_use_id ?? '';
          if (!id) continue;
          const existing = pairs.get(id);
          if (existing) existing.resultMsg = i;
          else pairs.set(id, { useMsg: -1, resultMsg: i });
        }
      }
    }
  }

  // Walk pairs and find the smallest cutoff that places EVERY pair entirely
  // on one side. Recede only — the protect budget guarantees we can't
  // violate the tail size cap by receding.
  let safe = cutoff;
  for (const { useMsg, resultMsg } of pairs.values()) {
    if (useMsg < 0 || resultMsg === null) continue; // half-known, leave alone
    const minSide = Math.min(useMsg, resultMsg);
    const maxSide = Math.max(useMsg, resultMsg);
    if (minSide < safe && maxSide >= safe) {
      safe = minSide;
    }
  }

  // Defensive: if cutoff landed on a `tool` role, advance past it so the tail
  // never starts with an orphaned tool_result.
  while (safe < messages.length && messages[safe].role === 'tool') {
    safe++;
  }
  return safe;
}

/**
 * Recede `cutoff` toward 0 until at least `n` user-role messages live in the
 * tail (PR-3, R4 from docs/agent-research/COMPARISON.md). Mirrors kimi-cli's
 * "preserve last 2 user/assistant turn pairs verbatim" rule. Keeping the last
 * N user messages plus everything after them as raw text lets the model
 * retain the exact wording of recent intent.
 *
 * `maxTailTokens` (optional) caps how far we recede: preserving N user turns is
 * best-effort, but the preserved tail must never blow the budget. Without it, a
 * single long user turn (history has < N user messages) recedes all the way to
 * 0 and the caller no-ops — the compactor can never reduce the turn, so the
 * size gate loops. With it, we stop receding before the tail exceeds the
 * ceiling and return the furthest-back SAFE boundary (still > 0, so a
 * compactable head remains) instead of giving up. This is what lets compaction
 * summarize WITHIN a long single turn.
 *
 * Caller is expected to feed the result through `snapCutoffPreservingPairs`
 * so atomic tool_use/tool_result pairs aren't split — this function only
 * recedes; it never advances.
 */
export function recedeToPreserveLastNTurns(
  messages: AgentMessage[],
  cutoff: number,
  n: number,
  maxTailTokens?: number,
): number {
  if (n <= 0 || cutoff <= 0 || cutoff >= messages.length) return cutoff;

  // Seed the running tail size + user count from messages already in the tail
  // (indices >= cutoff). Token accounting only runs when a budget is set.
  let tailTokens = 0;
  let userInTail = 0;
  for (let i = cutoff; i < messages.length; i++) {
    if (maxTailTokens != null) tailTokens += estimateMessageTokens(messages[i]);
    if (messages[i].role === 'user') userInTail++;
  }
  if (userInTail >= n) return cutoff;

  // Walk backward from cutoff-1, receding the boundary. Stop as soon as we have
  // N user messages, or — when a budget is set — as soon as one more message
  // would push the preserved tail over `maxTailTokens`.
  let needed = n - userInTail;
  let safe = cutoff;
  for (let i = cutoff - 1; i >= 0; i--) {
    if (maxTailTokens != null) {
      const t = estimateMessageTokens(messages[i]);
      if (tailTokens + t > maxTailTokens) return safe; // budget hit — keep head compactable
      tailTokens += t;
    }
    safe = i;
    if (messages[i].role === 'user') {
      needed--;
      if (needed === 0) return i;
    }
  }
  // Fewer than N user messages exist in history. With a budget the loop above
  // already returned a SAFE positive boundary before reaching here unless the
  // whole history fits the budget (then nothing needs compacting). Without a
  // budget, fall back to legacy behaviour: keep everything raw → caller no-ops.
  return maxTailTokens != null ? safe : 0;
}

/**
 * Recede `cutoff` toward 0 until the tail holds at least `n` RENDERABLE
 * (non-`tool`) messages — i.e. user + assistant turns. This is the
 * message-count FLOOR that guarantees a meaningful recent tail regardless of
 * token density.
 *
 * Why this exists on top of `recedeToPreserveLastNTurns`: that sibling only
 * counts `user` turns, of which an autonomous run has almost none (one initial
 * request, then hundreds of assistant/tool turns). With the token tail measured
 * as a fraction of the window, a token-dense recent stretch (file reads,
 * code_exec, search dumps) collapses the tail to a couple of messages — the
 * agent then loses its just-gathered working state and re-explores. Counting
 * ALL renderable turns gives a floor the token math can't defeat.
 *
 * `maxTailTokens` (optional) caps how far we recede: the floor is BEST-EFFORT
 * under the token ceiling. When recent turns are so dense that even `n` of them
 * exceed the ceiling, we stop at the furthest-back boundary that still fits and
 * return it (`spillOversizedToolResults` is the relief valve that frees room on
 * the next pass). Without a budget we recede freely to satisfy the floor.
 *
 * Recedes only (never advances) and never receives a `tool` message as the new
 * boundary's first kept turn — the caller still feeds the result through
 * `snapCutoffPreservingPairs` to keep tool_use/tool_result pairs atomic.
 */
export function recedeToPreserveLastNRenderableTurns(
  messages: AgentMessage[],
  cutoff: number,
  n: number,
  maxTailTokens?: number,
): number {
  if (n <= 0 || cutoff <= 0 || cutoff >= messages.length) return cutoff;

  // Seed the running tail size + renderable count from the existing tail.
  let tailTokens = 0;
  let renderableInTail = 0;
  for (let i = cutoff; i < messages.length; i++) {
    if (maxTailTokens != null) tailTokens += estimateMessageTokens(messages[i]);
    if (messages[i].role !== 'tool') renderableInTail++;
  }
  if (renderableInTail >= n) return cutoff;

  let needed = n - renderableInTail;
  let safe = cutoff;
  for (let i = cutoff - 1; i >= 0; i--) {
    if (maxTailTokens != null) {
      const t = estimateMessageTokens(messages[i]);
      if (tailTokens + t > maxTailTokens) return safe; // ceiling hit — best-effort
      tailTokens += t;
    }
    safe = i;
    if (messages[i].role !== 'tool') {
      needed--;
      if (needed === 0) return i;
    }
  }
  // Fewer than N renderable messages exist before the original cutoff. With a
  // budget the loop returned a SAFE bounded boundary unless everything fit
  // (then `safe` reached 0). Either way `safe` is the furthest valid recede.
  return safe;
}

/**
 * Adjust cutoff so it never falls between an assistant message (with tool_use
 * blocks) and its paired tool message (with tool_result blocks).
 *
 * @deprecated Use `snapCutoffPreservingPairs` — handles split pairs correctly.
 */
export function snapCutoffToRoleBoundary(messages: AgentMessage[], cutoff: number): number {
  while (cutoff < messages.length && messages[cutoff].role === 'tool') {
    cutoff++;
  }
  if (cutoff < messages.length && messages[cutoff].role === 'assistant') {
    cutoff++;
    while (cutoff < messages.length && messages[cutoff].role === 'tool') {
      cutoff++;
    }
  }
  return cutoff;
}
