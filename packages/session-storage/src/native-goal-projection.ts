import { createHash } from 'node:crypto';
import type { FsSessionGoal } from './fs-store/operational-types.js';

/** Embedded in a confirmed Host tool result, never in provider-supplied input. */
export interface NativeGoalState {
  text: string;
  status: 'in_progress' | 'complete' | 'superseded';
  budgetTokens: number | null;
  completionNote: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface NativeGoalMutation {
  version: 1;
  toolUseId: string;
  toolName: 'create_goal' | 'update_goal';
  expected: NativeGoalState | null;
  next: NativeGoalState;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native goal record');
  return value as Record<string, unknown>;
}
export function parseNativeGoalState(value: unknown): NativeGoalState {
  const g = object(value);
  if (typeof g.text !== 'string' || !g.text.trim() || g.text.length > 8_192
    || !['in_progress', 'complete', 'superseded'].includes(g.status as string)
    // Older goals allowed positive fractional soft budgets. Preserve those
    // values on resume; newly created goals still require integer input.
    || (g.budgetTokens !== null && (typeof g.budgetTokens !== 'number' || !Number.isFinite(g.budgetTokens)
      || g.budgetTokens <= 0 || g.budgetTokens > Number.MAX_SAFE_INTEGER))
    || (g.completionNote !== null && (typeof g.completionNote !== 'string' || g.completionNote.length > 8_192))
    || ![g.createdAt, g.updatedAt].every(v => typeof v === 'string' && v.length <= 32 && Number.isFinite(Date.parse(v)))) {
    throw new Error('Invalid native goal state');
  }
  return { text: g.text, status: g.status as NativeGoalState['status'], budgetTokens: g.budgetTokens as number | null,
    completionNote: g.completionNote as string | null, createdAt: g.createdAt as string, updatedAt: g.updatedAt as string };
}
export function sameNativeGoal(a: NativeGoalState | null, b: NativeGoalState | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function parseNativeGoalMutation(value: unknown, toolUseId: string, toolName: string): NativeGoalMutation {
  const m = object(value);
  if (m.version !== 1 || m.toolUseId !== toolUseId || m.toolName !== toolName
    || !['create_goal', 'update_goal'].includes(toolName)) throw new Error('Native goal attribution diverged');
  const expected = m.expected === null ? null : parseNativeGoalState(m.expected);
  const next = parseNativeGoalState(m.next);
  if (!sameNativeGoal(expected, next)) {
    if (toolName === 'create_goal') {
      if (expected?.status === 'in_progress' || next.status !== 'in_progress' || next.completionNote !== null
        || next.createdAt !== next.updatedAt) throw new Error('Invalid native goal creation');
    } else if (!expected || expected.status !== 'in_progress' || next.status === 'in_progress'
      || next.text !== expected.text || next.createdAt !== expected.createdAt || next.budgetTokens !== expected.budgetTokens
      || (next.status === 'superseded' && !next.completionNote?.trim())) throw new Error('Invalid native goal transition');
  } else if ((toolName === 'create_goal') !== (next.status === 'in_progress')) throw new Error('Invalid native goal no-op');
  return { version: 1, toolUseId, toolName: toolName as NativeGoalMutation['toolName'], expected, next };
}

/** Consume only complete, hash-verified result/terminal pairs from the native journal. */
export class NativeGoalProjection {
  private state: NativeGoalState | undefined;
  private revision = 0;
  constructor(private readonly sessionId: string) {}
  apply(value: unknown, toolUseId: string, toolName: string, isError: boolean): void {
    if (value === undefined) {
      if (!isError && ['create_goal', 'update_goal'].includes(toolName)) throw new Error('Successful native goal lacks a confirmed mutation');
      return;
    }
    if (isError) throw new Error('Failed native goal result carries a mutation');
    const m = parseNativeGoalMutation(value, toolUseId, toolName);
    if (this.state && !sameNativeGoal(this.state, m.expected)) throw new Error('Native goal history is discontinuous');
    if (!this.state || !sameNativeGoal(this.state, m.next)) this.revision++;
    this.state = m.next;
  }
  get value(): FsSessionGoal | undefined {
    if (!this.state) return undefined;
    const g = this.state;
    const hex = createHash('sha256').update(this.sessionId).update('\0').update(g.createdAt).digest('hex');
    return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
      text: g.text, status: g.status, budget_tokens: g.budgetTokens, completion_note: g.completionNote,
      created_at: g.createdAt, updated_at: g.updatedAt, revision: this.revision, mutation_seq: this.revision };
  }
}
