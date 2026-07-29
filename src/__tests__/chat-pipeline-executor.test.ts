/**
 * PR-2 — ChatPipelineExecutor end-to-end smoke test.
 *
 * Builds a 3-node graph (agent → validate → agent) and runs it with a
 * stub ChatProvider whose responses depend on the system prompt:
 *   - validator stages call submit_verdict({verdict: 'pass'})
 *   - regular agent stages emit a short summary text and stop
 *
 * Asserts: status transitions, branch routing, token rollup onto the
 * parent chat session, and node persistence under `coder_session_id`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';
import { ChatPipelineExecutor } from '@mcp/code-agent/pipelines/ChatPipelineExecutor.js';
import { createChatPipelineBus, type ChatPipelineEvent } from '@mcp/code-agent/pipelines/lib/eventBus.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type {
  Pipeline,
  PipelineExecutionContext,
  PipelineGraph,
} from '@mcp/company/types.js';

// ─── Stub provider ──────────────────────────────────────────────

interface StubCounters {
  agentCalls: number;
  validatorCalls: number;
}

interface PipelineTemplateStore {
  getPipeline(id: number): Pipeline | null;
  createPipeline(input: {
    name: string;
    description: string;
    graph: PipelineGraph;
    companySessionId: null;
  }): Pipeline & { id: number };
}

function makePipelineTemplateStore(): PipelineTemplateStore {
  const pipelines = new Map<number, Pipeline & { id: number }>();
  let nextId = 1;
  return {
    getPipeline: (id) => pipelines.get(id) ?? null,
    createPipeline(input) {
      const now = new Date().toISOString();
      const pipeline: Pipeline & { id: number } = {
        id: nextId++,
        name: input.name,
        description: input.description,
        project_id: null,
        company_session_id: input.companySessionId,
        template_id: null,
        graph: input.graph,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      pipelines.set(pipeline.id, pipeline);
      return pipeline;
    },
  };
}

function makeStubProvider(counters: StubCounters): ChatProvider {
  return {
    name: 'stub',
    model: 'stub-1',
    setModel(m: string) {
      this.model = m;
    },
    async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
      const isValidator = /PIPELINE VALIDATOR/.test(req.system);
      if (isValidator) {
        // Validator only has one tool — any tool_result in the prior
        // messages means the verdict was already submitted; stop.
        const hasToolResult = req.messages.some((m) =>
          m.content.some((b) => b.type === 'tool_result'),
        );
        if (hasToolResult) {
          yield { type: 'text_delta', text: 'Verdict already submitted.' };
          yield { type: 'usage', usage: { input_tokens: 4, output_tokens: 2 } };
          yield { type: 'done', stop_reason: 'end_turn' };
          return;
        }
        counters.validatorCalls++;
        yield {
          type: 'tool_call_end',
          id: 'tc-validator-1',
          name: 'submit_verdict',
          input: { verdict: 'pass', reason: 'Output meets the configured criteria.', confidence: 'medium' },
        };
        yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 8 } };
        yield { type: 'done', stop_reason: 'tool_use' };
        return;
      }
      counters.agentCalls++;
      yield { type: 'text_delta', text: `AGENT-SUMMARY (call ${counters.agentCalls}): work complete.` };
      yield { type: 'usage', usage: { input_tokens: 20, output_tokens: 12 } };
      yield { type: 'done', stop_reason: 'end_turn' };
    },
  };
}

// ─── Test setup ─────────────────────────────────────────────────

describe('ChatPipelineExecutor — 3-node end-to-end', () => {
  let workDir: string;
  let companyStore: PipelineTemplateStore;
  let sessionStore: FsSessionStore;
  let projectId: number;
  let coderSessionId: SessionId;
  let pipelineId: number;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'chat-pipe-'));
    companyStore = makePipelineTemplateStore();
    projectId = 1;
    const dataDir = join(workDir, 'data');
    mkdirSync(dataDir);
    sessionStore = FsSessionStore.fromRoots({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (id) => id === projectId ? workDir : null,
        listProjectRoots: () => [
          { project_id: projectId, root_path: workDir },
        ],
      },
    });

    const session = await sessionStore.createSession({
      project_id: projectId,
      title: 'pipeline test',
      provider: 'stub',
      model: 'stub-1',
    });
    coderSessionId = session.id;

    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'investigate',
      nodes: [
        {
          id: 'investigate',
          label: 'Investigate',
          role: 'investigator',
          taskTemplate: '{{initial_input}}',
        },
        {
          id: 'validate',
          label: 'Validate',
          role: 'validator',
          taskTemplate: '{{previous_output}}',
          kind: 'validate',
          branchMode: 'pass-fail',
          validatorPrompt: 'Pass when the output is non-empty; fail otherwise.',
        },
        {
          id: 'summarize',
          label: 'Summarize',
          role: 'writer',
          taskTemplate: 'Summarize the prior output:\n\n{{previous_output}}',
        },
      ],
      edges: [
        { kind: 'linear', id: 'e1', from: 'investigate', to: 'validate' },
        { kind: 'pass-fail', id: 'ep', from: 'validate', on: 'pass', to: 'summarize' },
        { kind: 'pass-fail', id: 'ef', from: 'validate', on: 'fail', to: 'investigate' },
      ],
    };
    const pipeline = companyStore.createPipeline({
      name: 'investigate-validate-summarize',
      description: 'smoke test',
      graph,
      companySessionId: null,
    });
    pipelineId = pipeline.id;
  });

  afterEach(async () => {
    await sessionStore.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('runs all three nodes, routes pass to summarize, and rolls usage onto the chat session', async () => {
    const counters: StubCounters = { agentCalls: 0, validatorCalls: 0 };
    const provider = makeStubProvider(counters);
    const bus = createChatPipelineBus();
    const events: ChatPipelineEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const executor = new ChatPipelineExecutor({
      coderSessionId,
      defaultProvider: provider,
      parentTools: [],
      baseContext: { cwd: workDir, projectName: 'chat-pipe-proj' },
      sessionStore,
      companyStore,
      bus,
    });

    const terminal = new Promise<ChatPipelineEvent>((resolve) => {
      bus.subscribe((e) => {
        if (
          e.name === 'pipeline_completed' ||
          e.name === 'pipeline_failed' ||
          e.name === 'pipeline_aborted'
        ) {
          resolve(e);
        }
      });
    });

    const exec = await executor.start(pipelineId, 'investigate the codebase', 'user-test');
    expect(exec.status).toBe('running');
    expect(exec.coder_session_id).toBe(coderSessionId);

    const final = await terminal;
    expect(final.name).toBe('pipeline_completed');

    // Three nodes: investigate (agent) + validate (validator) + summarize (agent)
    const rows =
      await sessionStore.chatPipelines.listNodeExecutions(
        coderSessionId,
        exec.id,
      );
    expect(rows.map((r) => r.node_id)).toEqual(['investigate', 'validate', 'summarize']);
    expect(rows.every((r) => r.status === 'completed')).toBe(true);

    // Branch routing: validate produced 'pass'.
    const validateRow = rows.find((r) => r.node_id === 'validate')!;
    expect(validateRow.outcome_branch).toBe('pass');
    // Agent stages routed via 'linear' (single linear out-edge from investigate).
    const investigateRow = rows.find((r) => r.node_id === 'investigate')!;
    expect(investigateRow.outcome_branch).toBe('linear');

    // Usage stored on each row.
    expect(validateRow.usage_json).toBeTruthy();
    expect(investigateRow.usage_json).toBeTruthy();

    // Usage rolled up onto the parent session.
    const sess = await sessionStore.getSession(coderSessionId);
    expect(sess).toBeTruthy();
    expect(sess!.total_input_tokens).toBeGreaterThan(0);
    expect(sess!.total_output_tokens).toBeGreaterThan(0);

    // Counters confirm per-stage spawn count.
    expect(counters.agentCalls).toBeGreaterThanOrEqual(2); // investigate + summarize
    expect(counters.validatorCalls).toBe(1);

    // Final execution row is `completed`.
    const finalExec =
      await sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
        coderSessionId,
        exec.id,
      );
    expect(finalExec?.status).toBe('completed');
    expect(finalExec?.finished_at).toBeTruthy();
  }, 30000);

  it('routes through fail edge when verdict=fail', async () => {
    // Override the stub to emit fail on first validator call, pass on second.
    let validatorTurnsSeen = 0;
    const provider: ChatProvider = {
      name: 'stub',
      model: 'stub-1',
      setModel() {},
      async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
        const isValidator = /PIPELINE VALIDATOR/.test(req.system);
        if (isValidator) {
          const hasToolResult = req.messages.some((m) =>
            m.content.some((b) => b.type === 'tool_result'),
          );
          if (hasToolResult) {
            yield { type: 'text_delta', text: 'done' };
            yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
            yield { type: 'done', stop_reason: 'end_turn' };
            return;
          }
          validatorTurnsSeen++;
          const verdict = validatorTurnsSeen === 1 ? 'fail' : 'pass';
          yield {
            type: 'tool_call_end',
            id: `tc-v-${validatorTurnsSeen}`,
            name: 'submit_verdict',
            input: { verdict, reason: `decision ${validatorTurnsSeen}`, confidence: 'high' },
          };
          yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 3 } };
          yield { type: 'done', stop_reason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'agent ok' };
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 3 } };
        yield { type: 'done', stop_reason: 'end_turn' };
      },
    };

    const bus = createChatPipelineBus();
    const executor = new ChatPipelineExecutor({
      coderSessionId,
      defaultProvider: provider,
      parentTools: [],
      baseContext: { cwd: workDir, projectName: 'chat-pipe-proj' },
      sessionStore,
      companyStore,
      bus,
    });
    const terminal = new Promise<ChatPipelineEvent>((resolve) => {
      bus.subscribe((e) => {
        if (
          e.name === 'pipeline_completed' ||
          e.name === 'pipeline_failed' ||
          e.name === 'pipeline_aborted'
        ) {
          resolve(e);
        }
      });
    });

    const exec = await executor.start(pipelineId, 'kick it', 'user');
    const final = await terminal;
    expect(final.name).toBe('pipeline_completed');

    const rows =
      await sessionStore.chatPipelines.listNodeExecutions(
        coderSessionId,
        exec.id,
      );
    // investigate, validate(fail), investigate (retry), validate(pass), summarize
    expect(rows.map((r) => r.node_id)).toEqual([
      'investigate',
      'validate',
      'investigate',
      'validate',
      'summarize',
    ]);
    expect(rows[1].outcome_branch).toBe('fail');
    expect(rows[3].outcome_branch).toBe('pass');
    expect(validatorTurnsSeen).toBe(2);
  }, 30000);

  it('pauses for confirmation between stages and resumes via confirm()', async () => {
    // Two-stage pipeline: investigate (agent, requires_confirmation) → summarize.
    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        {
          id: 'a',
          label: 'A',
          role: 'role-a',
          taskTemplate: '{{initial_input}}',
          requires_confirmation: true,
        },
        {
          id: 'b',
          label: 'B',
          role: 'role-b',
          taskTemplate: '{{previous_output}}',
        },
      ],
      edges: [{ kind: 'linear', id: 'e1', from: 'a', to: 'b' }],
    };
    const pipeline = companyStore.createPipeline({
      name: 'with-confirmation',
      description: '',
      graph,
      companySessionId: null,
    });

    let agentCalls = 0;
    const provider: ChatProvider = {
      name: 'stub',
      model: 'stub-1',
      setModel() {},
      async *chat(): AsyncIterable<ChatDelta> {
        agentCalls++;
        yield { type: 'text_delta', text: `agent ${agentCalls}` };
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 3 } };
        yield { type: 'done', stop_reason: 'end_turn' };
      },
    };

    const bus = createChatPipelineBus();
    const events: ChatPipelineEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const executor = new ChatPipelineExecutor({
      coderSessionId,
      defaultProvider: provider,
      parentTools: [],
      baseContext: { cwd: workDir, projectName: 'chat-pipe-proj' },
      sessionStore,
      companyStore,
      bus,
    });

    const pausedEvent = new Promise<ChatPipelineEvent>((resolve) => {
      bus.subscribe((e) => {
        if (e.name === 'pipeline_paused') resolve(e);
      });
    });

    const exec = await executor.start(pipeline.id, 'go', 'user');
    const paused = await pausedEvent;
    expect(paused.payload?.awaitingConfirmation).toBe(true);
    expect(paused.payload?.fromNodeId).toBe('a');
    expect(paused.payload?.nodeId).toBe('b');

    // After pause: only `a` ran; `b` hasn't yet.
    let rows =
      await sessionStore.chatPipelines.listNodeExecutions(
        coderSessionId,
        exec.id,
      );
    expect(rows.map((r) => r.node_id)).toEqual(['a']);

    // The execution row is paused with current_node_id pointing at the
    // node we're about to run on confirm.
    const pausedExec =
      await sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
        coderSessionId,
        exec.id,
      );
    expect(pausedExec?.status).toBe('paused');
    expect(pausedExec?.current_node_id).toBe('b');
    expect(pausedExec?.context.vars._pending_confirmation).toBeTruthy();

    // Now approve.
    const completed = new Promise<ChatPipelineEvent>((resolve) => {
      bus.subscribe((e) => {
        if (e.name === 'pipeline_completed') resolve(e);
      });
    });
    const ok = await executor.confirm(exec.id);
    expect(ok).toBe(true);

    await completed;
    rows = await sessionStore.chatPipelines.listNodeExecutions(
      coderSessionId,
      exec.id,
    );
    expect(rows.map((r) => r.node_id)).toEqual(['a', 'b']);
    expect(agentCalls).toBeGreaterThanOrEqual(2);

    // _pending_confirmation marker must be cleared after confirm().
    const finalExec =
      await sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
        coderSessionId,
        exec.id,
      );
    expect(finalExec?.context.vars._pending_confirmation).toBeUndefined();
  }, 30000);

  it('exposes validatorTools to the validator subagent', async () => {
    // Build a 2-stage pipeline (investigate → validate) where the
    // validator opts into `read_file`. Stub a fake `read_file` tool we
    // can inspect; the stub provider calls it once before submitting.
    const fakeReadFileCalls: Record<string, unknown>[] = [];
    const fakeReadFile: CoderTool = {
      name: 'read_file',
      description: 'fake',
      parameters: { type: 'object', properties: {} } as unknown as CoderTool['parameters'],
      source: 'native',
      handler: async (args) => {
        fakeReadFileCalls.push(args);
        return { content: 'file contents' };
      },
    };

    const graph: PipelineGraph = {
      version: 1,
      startNodeId: 'a',
      nodes: [
        { id: 'a', label: 'A', role: 'r', taskTemplate: '{{initial_input}}' },
        {
          id: 'v',
          label: 'V',
          role: 'r',
          taskTemplate: '{{previous_output}}',
          kind: 'validate',
          branchMode: 'pass-fail',
          validatorPrompt: 'Always pass.',
          validatorTools: ['read_file'],
        },
        { id: 'done', label: 'Done', role: 'r', taskTemplate: '{{previous_output}}' },
      ],
      edges: [
        { kind: 'linear', id: 'e1', from: 'a', to: 'v' },
        { kind: 'pass-fail', id: 'ep', from: 'v', on: 'pass', to: 'done' },
      ],
    };
    const pipeline = companyStore.createPipeline({
      name: 'with-validator-tools',
      description: '',
      graph,
      companySessionId: null,
    });

    // Walk-through state: "fresh" → "after_read_file" → "after_verdict".
    // Each tool_result advances the validator state. Per-call mutation
    // means a single validator run produces: read_file → submit_verdict.
    type ValidatorState = 'fresh' | 'after_read' | 'after_verdict';
    let state: ValidatorState = 'fresh';
    const provider: ChatProvider = {
      name: 'stub',
      model: 'stub-1',
      setModel() {},
      async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
        const isValidator = /PIPELINE VALIDATOR/.test(req.system);
        if (!isValidator) {
          yield { type: 'text_delta', text: 'agent' };
          yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 3 } };
          yield { type: 'done', stop_reason: 'end_turn' };
          return;
        }
        if (state === 'fresh') {
          state = 'after_read';
          yield {
            type: 'tool_call_end',
            id: 'tc-read',
            name: 'read_file',
            input: { path: '/some/file.ts' },
          };
          yield { type: 'usage', usage: { input_tokens: 3, output_tokens: 2 } };
          yield { type: 'done', stop_reason: 'tool_use' };
          return;
        }
        if (state === 'after_read') {
          state = 'after_verdict';
          yield {
            type: 'tool_call_end',
            id: 'tc-v',
            name: 'submit_verdict',
            input: { verdict: 'pass', reason: 'Read confirmed.', confidence: 'high' },
          };
          yield { type: 'usage', usage: { input_tokens: 6, output_tokens: 4 } };
          yield { type: 'done', stop_reason: 'tool_use' };
          return;
        }
        // after_verdict — stop the validator.
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'done', stop_reason: 'end_turn' };
      },
    };

    const bus = createChatPipelineBus();
    const executor = new ChatPipelineExecutor({
      coderSessionId,
      defaultProvider: provider,
      parentTools: [fakeReadFile],
      baseContext: { cwd: workDir, projectName: 'chat-pipe-proj' },
      sessionStore,
      companyStore,
      bus,
    });

    const completed = new Promise<ChatPipelineEvent>((resolve) => {
      bus.subscribe((e) => {
        if (
          e.name === 'pipeline_completed' ||
          e.name === 'pipeline_failed' ||
          e.name === 'pipeline_aborted'
        ) {
          resolve(e);
        }
      });
    });
    await executor.start(pipeline.id, 'kick', 'user');
    const final = await completed;
    expect(final.name).toBe('pipeline_completed');
    // The validator actually invoked our read_file.
    expect(fakeReadFileCalls.length).toBe(1);
  }, 30000);
});
