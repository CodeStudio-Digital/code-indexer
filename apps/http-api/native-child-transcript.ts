import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { NativeSessionReader, replayNativeCommittedEvents, type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { resolveNativeChildSessionRoot } from './native-child-storage.js';
import { NativeCoderEventProjection } from './sse/native-coder-events.js';
import { appendNativeChildTranscriptSeed } from './native-child-transcript-seed.js';

/** A bounded digest over the validated initial frontier and committed events.
 * It never opens a writer or replays tools/provider requests. */
export async function readNativeChildTranscript(input: { context: ControlPlaneRunContext; rootPath: string;
  runtimePackage: VerifiedRuntimePackage; maxChars?: number; signal?: AbortSignal; assertOwner(): void | Promise<void> }): Promise<string> {
  const maxChars = input.maxChars === undefined ? 15_000 : Math.min(60_000, Math.max(2_000, Math.floor(input.maxChars)));
  if (!Number.isFinite(maxChars)) throw new Error('Invalid native transcript digest bound');
  input.signal?.throwIfAborted(); await input.assertOwner();
  const rootPath = await resolveNativeChildSessionRoot(input.rootPath, input.context);
  const reader = await NativeSessionReader.open(input.runtimePackage, { rootPath, sessionId: input.context.sessionId });
  try {
    if (reader.state.authority?.writerId !== input.context.attemptId) throw new Error('Native child transcript reference has a different writer');
    const marker = '\n[Transcript digest truncated at the requested character budget.]';
    let output = `Native child ${input.context.agentRunId}\nAttempt ${input.context.attemptId}\n`;
    let truncated = false, terminal = false;
    const append = (text: string) => {
      const remaining = maxChars - marker.length - output.length;
      if (text.length > remaining) truncated = true;
      output += text.slice(0, Math.max(0, remaining));
    };
    const project = new NativeCoderEventProjection((event, raw) => {
      const data = raw as { text?: string; name?: string; input?: unknown; result?: { content?: string; isError?: boolean } };
      if (event === 'text' && data.text) append(data.text);
      else if (event === 'tool_call_start') append(`\nTool ${data.name}: ${(JSON.stringify(data.input) ?? '').slice(0, 1200)}\n`);
      else if (event === 'tool_call_result') append(`Result ${data.name}${data.result?.isError ? ' [error]' : ''}: ${(data.result?.content ?? '').slice(0, 1200)}\n`);
    }, input.context.attemptId);
    await appendNativeChildTranscriptSeed(reader, input.context, append, () => truncated, input.signal);
    let lastYield = performance.now();
    if (!truncated) for await (const entry of replayNativeCommittedEvents(reader.store, input.context.sessionId, 0n, 100_000, input.signal)) {
      if (entry.record.identity?.agentRunId !== input.context.agentRunId || entry.record.identity.attemptId !== input.context.attemptId) {
        throw new Error('Native child journal contains foreign execution authority');
      }
      project.apply(entry); terminal = !!project.completed;
      if (truncated) break;
      if (performance.now() - lastYield >= 4) { await yieldToEventLoop(); lastYield = performance.now(); input.signal?.throwIfAborted(); }
    }
    await reader.assertCurrent(); await input.assertOwner(); input.signal?.throwIfAborted();
    if (!truncated && !terminal) append('\n[No committed terminal record; the transcript may be incomplete.]');
    return output + (truncated ? marker : '');
  } finally { await reader.close(); }
}
