/**
 * Reducer for `master_plan_posted`, `master_question_posted`,
 * `master_plan_resolved`, `master_question_resolved`, and
 * `master_prompt_cancelled`.
 *
 * All variants carry `{ prompt: MasterPrompt }`. We upsert by id so
 * SSE replay never reopens an already-resolved prompt and rehydration
 * on reattach merges cleanly.
 */
import type { MasterPrompt } from '@mcp/company-contracts';
import type { StreamState } from '../types.js';

export function applyMasterPrompt(prev: StreamState, prompt: MasterPrompt): StreamState {
  const next = new Map(prev.masterPrompts);
  next.set(prompt.id, prompt);
  return { ...prev, masterPrompts: next };
}

/**
 * Merge master prompts loaded from the initial REST fetch. Existing
 * entries with the same id keep their (possibly more up-to-date) state.
 */
export function hydrateMasterPrompts(prev: StreamState, prompts: MasterPrompt[]): StreamState {
  if (!Array.isArray(prompts) || prompts.length === 0) return prev;
  const next = new Map(prev.masterPrompts);
  let added = 0;
  for (const p of prompts) {
    if (!next.has(p.id)) {
      next.set(p.id, p);
      added++;
    }
  }
  if (added === 0) return prev;
  return { ...prev, masterPrompts: next };
}
