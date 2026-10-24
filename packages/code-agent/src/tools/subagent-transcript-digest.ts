import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { AgentMessage } from '../core/messages.js';
import type { ResumableAgentState } from './subagent-resume-registry.js';

export function transcriptBudget(value?: number): number {
  return Number.isFinite(value) ? Math.min(60_000, Math.max(2_000, Math.trunc(value!))) : 15_000;
}
function clip(text: string, maximum: number): string {
  // Excerpts must not normalize megabytes that will immediately be discarded.
  const prefix = text.slice(0, Math.max(2048, maximum * 8));
  const clean = prefix.replace(/\s+/g, ' ').trim();
  return clean.length <= maximum && prefix.length === text.length ? clean : `${clean.slice(0, maximum - 1)}…`;
}
function inputPreview(input: Record<string, unknown>): string {
  let entries = 0;
  const seen = new WeakSet<object>();
  const bounded = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return clip(value, 240);
    if (!value || typeof value !== 'object') return value;
    if (depth === 4 || entries >= 64 || seen.has(value)) return '[…]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 8).map(item => { entries++; return bounded(item, depth + 1); });
    const result: Record<string, unknown> = Object.create(null);
    let keys = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (keys++ === 8 || entries++ >= 64) { result['…'] = 'omitted'; break; }
      result[clip(key, 80)] = bounded((value as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  };
  try { return clip(JSON.stringify(bounded(input, 0)), 220); }
  catch { return '(unserializable input)'; }
}

function* events(messages: readonly AgentMessage[]): Generator<string | undefined> {
  const names = new Map<string, string>();
  for (const message of messages) for (const block of message.content) {
    let line: string | undefined;
    if (block.type === 'text' && (message.role === 'user' || message.role === 'assistant')) {
      const text = clip(block.text, 900);
      if (text) line = `[${message.role}] ${text}`;
    } else if (block.type === 'tool_use') {
      if (names.size >= 4096) names.delete(names.keys().next().value!);
      names.set(block.id, clip(block.name, 160));
      line = `  → ${clip(block.name, 160)} ${inputPreview(block.input)}`;
    } else if (block.type === 'tool_result') {
      const name = names.get(block.tool_use_id) ?? 'tool'; names.delete(block.tool_use_id);
      line = `  ← ${name}${block.is_error ? ' [ERROR]' : ''} (${block.content.length} chars) ${clip(block.content, 240)}`;
    } else if (block.type === 'thinking' && block.text.length) {
      line = `  ~ thinking (${block.text.length} chars)`;
    }
    // Yield even for omitted images/empty blocks so they cannot starve cancel.
    yield line;
  }
}

class Digest {
  readonly header: string;
  readonly capacity: number;
  private lines: string[] = [];
  private head = 0;
  private used = 0;
  private omitted = 0;
  constructor(readonly agent: ResumableAgentState, maximum?: number) {
    const tokens = (agent.usage.input_tokens ?? 0) + (agent.usage.output_tokens ?? 0);
    this.header = `[transcript agent=#${agent.agentIndex + 1} "${clip(agent.label, 160)}" profile=${clip(agent.profileId, 80)} `
      + `status=${clip(agent.reason, 80)} tools=${agent.toolCallCount} tokens=${tokens} attempt=${agent.attempt}]\nTask: ${clip(agent.task, 400)}\n`;
    this.capacity = transcriptBudget(maximum) - this.header.length - 110;
  }
  push(line: string | undefined): void {
    if (line === undefined) return;
    const bounded = line.length > this.capacity ? `${line.slice(0, this.capacity - 2)}…` : line;
    this.lines.push(bounded); this.used += bounded.length + 1;
    while (this.used > this.capacity && this.head < this.lines.length - 1) {
      this.used -= this.lines[this.head++]!.length + 1; this.omitted++;
    }
    if (this.head >= 128) { this.lines = this.lines.slice(this.head); this.head = 0; }
  }
  finish(): string {
    if (this.agent.failureNote) this.push(`[failure] ${clip(this.agent.failureNote, 500)}`);
    if (this.agent.finalText) this.push(`[final] ${clip(this.agent.finalText, 2000)}`);
    const notice = this.omitted ? `[… ${this.omitted} earlier event(s) elided — raise max_chars to see more]\n` : '';
    return `${this.header}\n${notice}${this.lines.slice(this.head).join('\n')}`;
  }
}

export function renderTranscriptDigest(agent: ResumableAgentState, messages: readonly AgentMessage[], maximum?: number): string {
  const digest = new Digest(agent, maximum);
  if (messages.length === 0) digest.push('[no retained transcript available; final report follows]');
  for (const line of events(messages)) digest.push(line);
  return digest.finish();
}

export async function renderTranscriptDigestAsync(agent: ResumableAgentState, messages: readonly AgentMessage[],
  maximum?: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const digest = new Digest(agent, maximum);
  if (messages.length === 0) digest.push('[no retained transcript available; final report follows]');
  let count = 0; let deadline = performance.now() + 4;
  for (const line of events(messages)) {
    digest.push(line);
    if (++count >= 128 || performance.now() >= deadline) {
      await yieldToLoop(undefined, { signal });
      signal?.throwIfAborted(); count = 0; deadline = performance.now() + 4;
    }
  }
  signal?.throwIfAborted();
  return digest.finish();
}
