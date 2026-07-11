import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import {
  formatSpanForPromptV3,
  renderResumeV3,
  summaryV2ToV3,
  summaryV3ToV2,
  summarizeSpanV3,
  type CompactionSummaryV2,
  type CompactionSummaryV3,
} from '../summarizer.js';

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function validSummary(overrides: Partial<CompactionSummaryV3> = {}): CompactionSummaryV3 {
  return {
    version: 3,
    chapter: {
      title: 'Implement reliable compaction',
      summary: 'The new span implemented and verified a structured conversation compactor.',
      user_requests: ['Implement the approved plan.'],
      decisions: ['Keep old exports compatible.'],
      work_completed: ['Added a strict V3 parser.'],
      files: [{ path: 'src/core/summarizer.ts', state: 'Uses the V3 path.' }],
      open_issues: [],
      resolved_issues: ['The prior summary is no longer a user turn.'],
    },
    resume: {
      objective: 'Finish the reliable conversation compaction rollout.',
      current_focus: 'Running focused tests.',
      constraints: ['Preserve V2 exports.'],
      pending_tasks: ['Run the focused test suite.'],
      next_step: 'Run Vitest.',
    },
    ...overrides,
  };
}

function responseProvider(
  response: string,
  capture?: (request: ChatRequest) => void,
): ChatProvider {
  return {
    name: 'mock',
    model: 'mock-summary-model',
    setModel() {},
    async *chat(request) {
      capture?.(request);
      yield { type: 'text_delta', text: response } as const;
      yield {
        type: 'usage',
        usage: { input_tokens: 120, output_tokens: 80, prompt_tokens_total: 140 },
      } as const;
    },
  };
}

describe('CompactionSummaryV3', () => {
  it('produces chapter + resume in one call with deterministic inference settings and metrics', async () => {
    let request: ChatRequest | undefined;
    const result = await summarizeSpanV3(
      { messages: [user('Implement the approved plan.')] },
      responseProvider(JSON.stringify(validSummary()), (value) => { request = value; }),
    );

    expect(result?.version).toBe(3);
    expect(result?.chapter.title).toContain('compaction');
    expect(result?.resume.objective).toContain('rollout');
    expect(result?.metrics).toMatchObject({
      model: 'mock-summary-model',
      input_tokens: 140,
      output_tokens: 80,
      input_messages: 1,
      cost_usd: null,
    });
    expect(request?.inference).toEqual({ temperature: 0 });
    expect(request?.reasoningEffort).toBe('minimal');
    expect(request?.thinking).toBe(false);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an empty JSON object instead of accepting a content-free summary', async () => {
    const result = await summarizeSpanV3(
      { messages: [user('There is real work here.')] },
      responseProvider('{}'),
    );
    expect(result).toBeNull();
  });

  it('keeps bidirectional V2 compatibility without restoring transcript duplication', () => {
    const v2: CompactionSummaryV2 = {
      primary_request: 'Preserve callers',
      key_concepts: ['compatibility'],
      files_and_code: [{ path: 'src/legacy.ts', state: 'unchanged' }],
      errors_and_fixes: ['Old parser was permissive'],
      problem_solving: 'Introduced an adapter.',
      all_user_messages: ['verbatim text must not be copied forward'],
      pending_tasks: ['Run tests'],
      current_work: 'Checking adapters',
      next_step: 'Run Vitest',
    };
    const v3 = summaryV2ToV3(v2);
    const roundTrip = summaryV3ToV2(v3);
    expect(v3.version).toBe(3);
    expect(roundTrip.primary_request).toBe(v2.primary_request);
    expect(roundTrip.files_and_code).toEqual(v2.files_and_code);
    expect(roundTrip.all_user_messages).toEqual([]);
  });

  it('moves a nested prior summary to system state and keeps it out of the user span', async () => {
    const prior = validSummary({
      resume: {
        objective: 'OLD OBJECTIVE SENTINEL',
        current_focus: 'old focus',
        constraints: [],
        pending_tasks: [],
        next_step: '',
      },
    });
    const priorMessage: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: renderResumeV3(prior) }],
    };
    let request: ChatRequest | undefined;
    const result = await summarizeSpanV3(
      { messages: [priorMessage, user('NEW SPAN SENTINEL')] },
      responseProvider(JSON.stringify(validSummary()), (value) => { request = value; }),
    );

    expect(result).not.toBeNull();
    expect(request?.system).toContain('OLD OBJECTIVE SENTINEL');
    const userPayload = (request?.messages[0]?.content[0] as { text?: string } | undefined)?.text ?? '';
    expect(userPayload).toContain('NEW SPAN SENTINEL');
    expect(userPayload).not.toContain('OLD OBJECTIVE SENTINEL');
    expect(userPayload).not.toContain('auto-compacted summary');
  });

  it('reserves prompt budget for the final instruction before head and middle samples', () => {
    const messages = Array.from({ length: 80 }, (_, index) => (
      user(`${'x'.repeat(500)} message-${index}${index === 79 ? ' TAIL_MARKER_MUST_SURVIVE' : ''}`)
    ));
    const prompt = formatSpanForPromptV3(messages, 2_000);
    expect(prompt.length).toBeLessThanOrEqual(2_000);
    expect(prompt).toContain('TAIL_MARKER_MUST_SURVIVE');
  });

  it('overlays structured task state after the model, including an explicitly empty task list', async () => {
    const result = await summarizeSpanV3(
      {
        messages: [user('Everything is complete.')],
        liveState: {
          goal: { text: 'Ship V3', status: 'in_progress' },
          activePlan: { text: 'Implement schema, then API', status: 'approved' },
          todos: [{ content: 'Old inferred task', status: 'completed' }],
        },
      },
      responseProvider(JSON.stringify(validSummary())),
    );
    expect(result?.resume.active_goal).toBe('Ship V3 (status=in_progress)');
    expect(result?.resume.pending_tasks).toEqual([]);
    expect(result?.resume.next_step).toBe('');
    expect(result?.resume.constraints).toContain(
      'Persisted active plan: Implement schema, then API (status=approved)',
    );
  });

  it('enforces the combined summary cap after validating the model shape', async () => {
    const huge = 'z'.repeat(2_000);
    const response = validSummary({
      chapter: {
        title: huge,
        summary: huge,
        user_requests: Array(20).fill(huge),
        decisions: Array(20).fill(huge),
        work_completed: Array(20).fill(huge),
        files: Array.from({ length: 20 }, (_, index) => ({ path: `src/${index}-${huge}`, state: huge })),
        open_issues: Array(20).fill(huge),
        resolved_issues: Array(20).fill(huge),
      },
      resume: {
        objective: huge,
        current_focus: huge,
        constraints: Array(20).fill(huge),
        pending_tasks: Array(20).fill(huge),
        next_step: huge,
      },
    });
    const result = await summarizeSpanV3(
      { messages: [user('Keep the result bounded.')] },
      responseProvider(JSON.stringify(response)),
    );
    const payload = JSON.stringify({ version: 3, chapter: result?.chapter, resume: result?.resume });
    expect(payload.length).toBeLessThanOrEqual(6_000);
  });

  it('propagates abort to the provider request and rejects promptly', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider: ChatProvider = {
      name: 'blocking',
      model: 'blocking-model',
      setModel() {},
      chat(request) {
        providerSignal = request.signal;
        return (async function* stream() {
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
          });
          if (false) yield { type: 'text_delta', text: '' } as const;
        })();
      },
    };
    const controller = new AbortController();
    const pending = summarizeSpanV3(
      { messages: [user('This call should be cancelled.')] },
      provider,
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);
  });
});
