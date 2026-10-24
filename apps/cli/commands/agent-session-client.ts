import { randomUUID } from 'node:crypto';
import { classifyCoderTerminalOutcome, type ClassifiedCoderTerminalOutcome } from '@mcp/agent-runtime-contracts';
import { readSSEEvents, SSEStreamInterruptedError } from '@mcp/shared/sse/readSSEEvents.js';
import { createAgentToolOutput } from './agent-output.js';
import { handleAgentInteraction } from './agent-interactions.js';

export interface AgentCliOptions {
  provider: string; model?: string; project?: string; session?: string;
  maxTurns?: number; plan?: boolean; agent?: string; profile?: string;
  worktree?: string | boolean; worktreeBranch?: string;
}
export type AgentCliRequest = (path: string, init?: RequestInit) => Promise<Response>;
export interface AgentCliIO {
  write(text: string): void;
  flush?(): Promise<void>;
  prompt(question: string, signal: AbortSignal): Promise<string>;
}
interface Session { id: string; provider: string; model: string; }

export async function agentCliJson<T>(request: AgentCliRequest, path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, { ...init,
    headers: { 'content-type': 'application/json', ...init?.headers } });
  if (!response.ok) throw new Error((await response.text()) || `Agent request failed: HTTP ${response.status}`);
  return await response.json() as T;
}

/** A transport client only. Runtime selection, admission, transcript ownership,
 * permission checks and continuation all remain in the product facade. */
export async function runAgentSession(input: { task: string; options: AgentCliOptions; projectId?: number;
  projectName?: string; request: AgentCliRequest; io: AgentCliIO; signal: AbortSignal }): Promise<ClassifiedCoderTerminalOutcome> {
  const { task, options, request, io, signal } = input;
  const json = <T>(path: string, init?: RequestInit) => agentCliJson<T>(request, path, { signal, ...init });
  const existing = options.session ? await json<{ session: Session }>(`/api/coder/sessions/${options.session}?tail=1`) : undefined;
  const session = existing?.session ?? await json<Session>('/api/coder/sessions', { method: 'POST',
    body: JSON.stringify({ project_id: input.projectId, title: task.slice(0, 60), provider: options.provider,
      model: options.model, agent: options.agent, max_turns: options.maxTurns, max_auto_continues: 0 }) });
  if (!session?.id || !/^[a-f0-9-]{36}$/i.test(session.id)) throw new Error('Agent session response omitted its identity');
  io.write(`\n  session ${session.id} (${session.provider}/${session.model})\n  project: ${input.projectName ?? options.project ?? '(session workspace)'}\n\n`);
  const path = `/api/coder/sessions/${session.id}`;
  let accepted = false;
  let busId: string | undefined;
  const stop = () => agentCliJson(request, `${path}/abort`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000) });
  const output = createAgentToolOutput(io.write);
  let inputTokens = 0; let outputTokens = 0;
  try {
    signal.throwIfAborted();
    const response = await request(`${path}/messages`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ content: task, client_msg_id: randomUUID(), max_turns: options.maxTurns,
        max_auto_continues: 0, plan_mode: options.plan, agent: options.agent, profile: options.profile,
        ...(!options.session && options.worktree !== undefined ? { worktree: {
          name: typeof options.worktree === 'string' ? options.worktree : undefined, branch: options.worktreeBranch } } : {}) }) });
    if (!response.ok) throw new Error((await response.text()) || `Agent stream failed: HTTP ${response.status}`);
    accepted = true;
    for await (const event of readSSEEvents(response, signal)) {
      const value: unknown = JSON.parse(event.data);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SSEStreamInterruptedError('Malformed agent event');
      const data = value as Record<string, unknown>;
      if (event.event === 'bus_info' && typeof data.bus_id === 'string') busId = data.bus_id;
      if (event.event === 'done' || event.event === 'error') {
        const terminal = classifyCoderTerminalOutcome({ event: event.event, reason: data.reason, error: data.error, message: data.message });
        io.write(`\n\n[done: ${terminal.reason}${terminal.message ? ` — ${terminal.message}` : ''}]\n`);
        const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        io.write(`tokens: ${usage?.input_tokens ?? inputTokens} in / ${usage?.output_tokens ?? outputTokens} out\n`);
        await io.flush?.();
        return terminal;
      }
      if (event.event === 'text' && typeof data.text === 'string') io.write(data.text);
      else if (event.event === 'tool_call_start') {
        const args = JSON.stringify(data.input) ?? '';
        io.write(`\n  ⚙ ${data.name} ${args.length > 120 ? args.slice(0, 120) + '…' : args}\n`);
      } else if (event.event === 'tool_call_result') {
        output.result(String(data.id), String(data.name), data.result as { content: string; isError?: boolean }, Number(data.duration_ms ?? 0));
      } else if (event.event === 'goal_mutations_persisted') output.persisted(data as unknown as { toolUseIds: string[] });
      else if (event.event === 'goal_mutations_persistence_failed') output.failed(data as unknown as { toolUseIds: string[]; message: string });
      else if (event.event === 'task_started') io.write(`\n  ▶ task_started ${data.task_id} (${data.mode})\n`);
      else if (event.event === 'task_finished') io.write(`\n  ✓ task_finished ${data.task_id} (${data.status})\n`);
      else if (event.event === 'stream_rollback') io.write('\n[The provider retracted its previous partial response.]\n');
      else if (event.event === 'message_complete') {
        const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        inputTokens += usage?.input_tokens ?? 0; outputTokens += usage?.output_tokens ?? 0;
      } else await handleAgentInteraction(event.event, data, {
        write: io.write, prompt: question => io.prompt(question, signal),
        respond: async (endpoint, body) => {
          signal.throwIfAborted();
          const result = await json<{ ok?: boolean; resumed_via_worker?: boolean }>(`${path}/${endpoint}`, { method: 'POST', body: JSON.stringify(body) });
          if (!result.ok || result.resumed_via_worker) throw new Error('Interaction did not reach the live attempt; continue the session explicitly');
        },
      });
      await io.flush?.();
    }
    throw new SSEStreamInterruptedError('Agent stream ended without a terminal receipt; execution was not retried');
  } catch (error) {
    if (accepted) {
      try { await stop(); }
      catch (cause) { throw new Error(`Agent interruption could not be acknowledged; execution was not retried: ${String(cause)}`, { cause: error }); }
    }
    if (signal.aborted && accepted) {
      // An abort ACK confirms the request, not the outcome. Reattach without
      // the user-aborted signal and wait for the same run's durable terminal.
      const drainSignal = AbortSignal.timeout(30_000);
      const response = await request(`${path}/attach`, { signal: drainSignal,
        headers: { accept: 'text/event-stream' } });
      if (!response.ok) throw new Error(`Agent cancellation outcome unavailable: HTTP ${response.status}`);
      let matched = busId === undefined;
      for await (const event of readSSEEvents(response, drainSignal)) {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        if (event.event === 'bus_info') {
          if (busId && data.bus_id !== busId) throw new Error('Agent cancellation stream belongs to a different run');
          matched = true;
        }
        if (event.event === 'done' || event.event === 'error') {
          if (!matched) throw new Error('Agent cancellation terminal omitted its expected run identity');
          const terminal = classifyCoderTerminalOutcome({ event: event.event, reason: data.reason, error: data.error, message: data.message });
          io.write(`\n\n[done: ${terminal.reason}]\n`);
          return terminal;
        }
      }
      throw new SSEStreamInterruptedError('Agent cancellation stream ended without a terminal receipt');
    }
    throw error;
  }
}
