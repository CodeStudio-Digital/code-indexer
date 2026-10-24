import type { PlanBlock, QuestionBlock, SpecBlock } from '@mcp/provider-sdk/wire.js';

export interface DecisionReview {
  id: string; header?: string; allowFreeform?: boolean;
  questions: Array<{ id: string; header?: string; question: string; multiSelect?: boolean;
    options: Array<{ label: string; value: string; summary?: string; tradeoffs?: string }> }>;
}
export type ToolReview = { kind: 'question'; payload: QuestionBlock }
  | { kind: 'decision'; payload: DecisionReview }
  | { kind: 'plan'; payload: PlanBlock }
  | { kind: 'spec'; payload: SpecBlock }
  | { kind: 'budget_request'; payload: { id: string; ask_id: string; run_id: string;
    spent: number; cap: number; estimated: number; options: ReadonlyArray<string> } }
  | { kind: 'tasks_posted'; payload: { id: string; tool_use_id: string; summary: string;
    tasks: import('@mcp/session-storage/session-state-types.js').CoderTask[]; version: number } };

/** Attempt-owned human interaction. Implementations register the waiter before
 * publication and fence responses by the review identity. No runner is exposed. */
export interface InteractiveToolPort {
  readonly agentId: string | null | undefined;
  readonly specMode: boolean;
  request(review: ToolReview, signal?: AbortSignal): Promise<string>;
  approvePlan(): void;
  approveSpec(path: string): void;
}
