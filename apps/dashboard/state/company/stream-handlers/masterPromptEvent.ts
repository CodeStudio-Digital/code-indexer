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
  const current = prev.masterPrompts.get(prompt.id);
  if (current && current.status !== 'pending') return prev;
  const next = new Map(prev.masterPrompts);
  next.set(prompt.id, prompt);
  return { ...prev, masterPrompts: next };
}

/** A prompt is posted once and resolved once. Snapshots and SSE can arrive in either order. */
export function hydrateMasterPrompts(prev: StreamState, prompts: MasterPrompt[]): StreamState {
  let next: Map<string, MasterPrompt> | undefined;
  for (const prompt of prompts) {
    const current = (next ?? prev.masterPrompts).get(prompt.id);
    if (current && (current.status !== 'pending' || prompt.status === 'pending')) continue;
    next ??= new Map(prev.masterPrompts);
    next.set(prompt.id, prompt);
  }
  return next ? { ...prev, masterPrompts: next } : prev;
}
