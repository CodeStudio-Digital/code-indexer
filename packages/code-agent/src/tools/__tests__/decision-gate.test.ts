import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { planTools, submitPlan } from '@mcp/code-agent/tools/plan.js';
import { interactionTools, decisionGate, formatDecisionGateResult } from '@mcp/code-agent/tools/interaction.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

class StubProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'done' };
  }
}

function makeRunner(opts: {
  planMode?: boolean;
  specMode?: boolean;
  planDepth?: 'simple' | 'normal' | 'complex';
} = {}) {
  const registry = new ToolRegistry();
  registry.registerAll(planTools);
  registry.registerAll(interactionTools);
  return new CoderRunner({
    provider: new StubProvider(),
    registry,
    systemPrompt: 'test',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    planMode: opts.planMode,
    specMode: opts.specMode,
    planDepth: opts.planDepth,
  });
}

const flush = () => new Promise((res) => setTimeout(res, 0));
const ctx = (r: CoderRunner) => ({ cwd: '/tmp', projectName: 'test', runner: r, planMode: true });

// A representative two-fork questionnaire.
const QUESTIONS = [
  {
    id: 'approach',
    header: 'Approach',
    question: 'Build new or reuse?',
    options: [
      { label: 'Build new', value: 'build', summary: 'from scratch' },
      { label: 'Reuse existing', value: 'reuse', summary: 'extend the current module', tradeoffs: 'less code, some coupling' },
    ],
  },
];

describe('formatDecisionGateResult', () => {
  it('maps chosen values back to labels, in question order', () => {
    const out = formatDecisionGateResult(QUESTIONS, { approach: { selected: ['reuse'] } });
    expect(out).toBe('User decided:\n- Approach: Reuse existing');
  });

  it('appends a free-form note', () => {
    const out = formatDecisionGateResult(QUESTIONS, { approach: { selected: ['build'], freeform: 'but keep it small' } });
    expect(out).toBe('User decided:\n- Approach: Build new — note: but keep it small');
  });

  it('joins multiple selected labels (multi-select)', () => {
    const q = [{ id: 'feats', question: 'which?', options: [
      { label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' },
    ] }];
    const out = formatDecisionGateResult(q, { feats: { selected: ['a', 'c'] } });
    expect(out).toBe('User decided:\n- feats: A, C');
  });

  it('falls back to the id label and (no selection) for empty answers', () => {
    const out = formatDecisionGateResult(QUESTIONS, {});
    expect(out).toBe('User decided:\n- Approach: (no selection)');
  });

  it('is byte-identical live (normalized args) vs resume (raw persisted input)', () => {
    // The live handler trims options before formatting; the /decide resume path
    // formats the RAW persisted tool_use input (untrimmed, snake_case). The same
    // logical questionnaire + decision MUST yield the identical tool_result, or a
    // restart mid-questionnaire diverges from the in-process result.
    const liveQuestions = [
      { id: 'approach', header: 'Approach', question: 'Build new or reuse?', options: [
        { label: 'Build new', value: 'build' },
        { label: 'Reuse existing', value: 'reuse' },
      ] },
    ];
    const rawQuestions = [
      { id: 'approach', header: '  Approach  ', question: 'Build new or reuse?', multi_select: false, options: [
        { label: '  Build new  ', value: ' build ' },
        { label: '  Reuse existing  ', value: ' reuse ' },
      ] },
    ] as unknown as typeof liveQuestions;
    const liveAnswers = { approach: { selected: ['reuse'] } };  // FE toggled the trimmed value
    const rawAnswers = { approach: { selected: [' reuse '] } };  // reload card toggles the raw value
    expect(formatDecisionGateResult(liveQuestions, liveAnswers)).toBe('User decided:\n- Approach: Reuse existing');
    expect(formatDecisionGateResult(rawQuestions, rawAnswers)).toBe(
      formatDecisionGateResult(liveQuestions, liveAnswers),
    );
  });
});

describe('decision_gate tool', () => {
  it('emits decision_posted and returns the formatted result', async () => {
    const r = makeRunner({ planMode: true, planDepth: 'normal' });
    let posted: { questions: Array<{ id: string }> } | null = null;
    r.on('decision_posted', (b) => { posted = b as typeof posted; });

    const resultP = decisionGate.handler({ questions: QUESTIONS }, ctx(r));
    await flush();
    expect(posted!.questions[0].id).toBe('approach');

    r.provideUserInput(JSON.stringify({ answers: { approach: { selected: ['reuse'] } } }));
    const result = await resultP;
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Reuse existing');
  });

  it('rejects a question with fewer than 2 options', async () => {
    const r = makeRunner({ planMode: true });
    const res = await decisionGate.handler(
      { questions: [{ id: 'x', question: 'q', options: [{ label: 'only', value: 'o', summary: 's' }] }] },
      ctx(r),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/2.4 options|2–4 options/);
  });

  it('rejects an option missing its summary', async () => {
    const r = makeRunner({ planMode: true });
    const res = await decisionGate.handler(
      { questions: [{ id: 'x', question: 'q', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b', summary: 's' }] }] },
      ctx(r),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/summary/);
  });

  it('rejects duplicate question ids', async () => {
    const r = makeRunner({ planMode: true });
    const dup = { id: 'same', question: 'q', options: [{ label: 'A', value: 'a', summary: 's' }, { label: 'B', value: 'b', summary: 's' }] };
    const res = await decisionGate.handler({ questions: [dup, dup] }, ctx(r));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/duplicate question id/);
  });

  it('aborts cleanly when the user dismisses', async () => {
    const r = makeRunner({ planMode: true });
    const resultP = decisionGate.handler({ questions: QUESTIONS }, ctx(r));
    await flush();
    r.provideUserInput(JSON.stringify({ aborted: true }));
    const res = await resultP;
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/aborted/i);
  });
});

describe('submit_plan does not infer forks from plan prose', () => {
  it.each([
    '## Approach\n\n1. Extend the existing module.\n2. Run tests.',
    'We could either extend the existing module or rewrite it. Two approaches exist.',
    'Option A keeps it inline; option B extracts a module. On the other hand, both are valid.',
  ])('posts on the first submission and waits for the user: %s', async (plan) => {
    const r = makeRunner({ planMode: true, planDepth: 'normal' });
    let posted = false;
    r.on('plan_posted', () => { posted = true; });

    const resultP = submitPlan.handler({ plan }, ctx(r));
    await flush();

    expect(posted).toBe(true);
    r.provideUserInput(JSON.stringify({ approved: true }));
    const result = await resultP;
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/approved/i);
  });

  it('is refused immediately in spec mode and never posts an interactive plan', async () => {
    const r = makeRunner({ specMode: true });
    let posted = false;
    r.on('plan_posted', () => { posted = true; });

    const result = await submitPlan.handler(
      { plan: 'This regular plan must not satisfy the spec gate.' },
      ctx(r),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/submit_spec/);
    expect(posted).toBe(false);
  });
});
