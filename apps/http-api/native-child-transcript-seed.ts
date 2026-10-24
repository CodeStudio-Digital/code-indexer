import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { decodeProviderFrontier, type NativeSessionReader } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { expandContextChapters } from '../../packages/agent-runtime-host/src/native/NativeContextChapters.js';
import { validateRecoveryPage, validateRecoveryPayload } from '../../packages/agent-runtime-host/src/native/NativeEngineEventRecovery.js';

/** A resumed child owns a new journal: inherited calls live in its initial
 * frontier, while subsequent calls live in events. Render that seed once. */
export async function appendNativeChildTranscriptSeed(reader: NativeSessionReader, context: ControlPlaneRunContext,
  append: (text: string) => void, full: () => boolean, signal?: AbortSignal): Promise<void> {
  let cursor = 0n, count = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (count >= 100_000) throw new Error('Native child transcript seed record bound exceeded');
    const maximum = Math.min(256, 100_000 - count), page = await reader.store.list(cursor, maximum);
    validateRecoveryPage(page, context.sessionId, cursor, maximum);
    for (const receipt of page.records) {
      cursor = receipt.globalSequence; count++;
      if (receipt.kind !== journal.SessionRecordKind.CHECKPOINT) continue;
      if (receipt.durability !== journal.SessionDurabilityClass.AUTHORITATIVE) throw new Error('Native child transcript seed is not authoritative');
      const bytes = await reader.store.read(receipt);
      validateRecoveryPayload(receipt, bytes);
      const frontier = decodeProviderFrontier(bytes).value;
      if (frontier.sessionId !== context.sessionId || frontier.agentRunId !== context.agentRunId
        || frontier.sourceAttemptId !== context.attemptId) throw new Error('Native child transcript seed belongs to another execution authority');
      const messages = await expandContextChapters(reader.store, context.sessionId, frontier.context!.messages, signal);
      const names = new Map<string, string>();
      let lastYield = performance.now();
      for (const message of messages) {
        signal?.throwIfAborted();
        for (const block of message.content) {
          const body = block.body;
          if (body.case === 'text') append((message.role === wire.ProviderMessageRole.USER ? '\nUser: ' : '')
            + (body.value.body.case === 'inlineUtf8' ? body.value.body.value : '[text artifact]'));
          else if (body.case === 'toolUse') {
            names.set(body.value.toolUseId, body.value.capabilityName);
            append(`\nTool ${body.value.capabilityName}: ${new TextDecoder().decode(body.value.encodedJsonArguments).slice(0, 1200)}\n`);
          } else if (body.case === 'toolResult') {
            const result = body.value, name = names.get(result.toolUseId) ?? result.toolUseId;
            names.delete(result.toolUseId);
            const content = result.content.case === 'inlineUtf8' ? result.content.value : '[result artifact]';
            append(`Result ${name}${result.isError ? ' [error]' : ''}: ${content.slice(0, 1200)}\n`);
          } else if (body.case === 'attachment') append(`\n[Attachment ${body.value.kind}: ${body.value.byteLength} bytes]\n`);
          if (full()) return;
        }
        if (performance.now() - lastYield >= 4) { await yieldToEventLoop(); lastYield = performance.now(); }
      }
      return;
    }
    if (page.complete) return;
    if (!page.records.length) throw new Error('Native child transcript seed cursor stalled');
  }
}
