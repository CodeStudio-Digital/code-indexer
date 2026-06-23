/**
 * Coverage for the docs_plan tool — records the agent's sub-question
 * decomposition into the shared PlanSlot.
 */
import { describe, it, expect } from 'vitest';
import { makeDocsPlanTool, type PlanSlot } from '../tools/docs-plan.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const ctx = {} as ToolContext;
const makeSlot = (): PlanSlot => ({ subQuestions: null });

describe('docs_plan', () => {
  it('records trimmed, non-empty sub-questions into the slot', async () => {
    const slot = makeSlot();
    const tool = makeDocsPlanTool({ slot });
    const res = await tool.handler(
      { sub_questions: ['How is X configured?', '   ', 'How does X interact with Y?'] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(slot.subQuestions).toEqual(['How is X configured?', 'How does X interact with Y?']);
  });

  it('rejects an all-empty list and leaves the slot null', async () => {
    const slot = makeSlot();
    const tool = makeDocsPlanTool({ slot });
    const res = await tool.handler({ sub_questions: ['', '   '] }, ctx);
    expect(res.isError).toBe(true);
    expect(slot.subQuestions).toBeNull();
  });

  it('caps the plan at 8 sub-questions', async () => {
    const slot = makeSlot();
    const tool = makeDocsPlanTool({ slot });
    const many = Array.from({ length: 12 }, (_, i) => `q${i}`);
    await tool.handler({ sub_questions: many }, ctx);
    expect(slot.subQuestions).toHaveLength(8);
  });

  it('fires the onCall counter', async () => {
    const slot = makeSlot();
    let calls = 0;
    const tool = makeDocsPlanTool({ slot, onCall: () => { calls++; } });
    await tool.handler({ sub_questions: ['q'] }, ctx);
    expect(calls).toBe(1);
  });
});
