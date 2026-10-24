import { createHash } from 'node:crypto';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { NativeContentAssembler, nativeToolUseId, type NativeCommittedEvent } from '@mcp/agent-runtime-host';
import { publish, type CoderRunBus } from '../coder-bus.js';
import { NativeCoderMessageProjection } from './native-coder-message.js';
import type { ContentBlock } from '@mcp/provider-sdk/wire.js';
import { decodeNativeToolUserMessage } from '@mcp/agent-runtime-host';
import { parseNativeTaskMutation } from '@mcp/session-storage/native-task-projection.js';
import { deriveTodosFromState } from '@mcp/code-agent/tools/task-list-shared.js';

/** Rebuildable compatibility projection. The native journal owns durability;
 * the existing SSE bus retains only its bounded live/reconnect window. */
export class NativeCoderEventProjection {
  private readonly assembler = new NativeContentAssembler();
  private pending?: { content: wire.EngineContentRecordV1; bytes: Uint8Array };
  private readonly tools = new Map<string, { name: string; publicId: string; started: boolean }>();
  private sequence = 0n;
  private terminal?: wire.EngineTerminalRecordV1;
  private uncertain = false;
  private sealed = false;
  private readonly message: NativeCoderMessageProjection;

  private readonly emit: (event: string, data: unknown) => void;
  constructor(bus: CoderRunBus | ((event: string, data: unknown) => void), private readonly attemptId: string,
    private readonly resolveToolUserMessage?: (encoded: string) => readonly ContentBlock[]) {
    this.emit = typeof bus === 'function' ? bus : (event, data) => publish(bus, event, data);
    this.message = new NativeCoderMessageProjection(this.emit);
  }

  get completed() { return this.terminal; }
  get totalUsage() { return this.message.totalUsage; }
  get hasUncertainEffects() { return this.uncertain; }

  /** Transport EOF or a projection failure can precede the run terminal. Keep
   * dispatched effects fenced until recovery can read their durable receipts. */
  finishStream(): void {
    this.sealed = true;
    if ([...this.tools.values()].some(tool => tool.started)) this.uncertain = true;
  }

  apply({ record, receipt }: NativeCommittedEvent): void {
    if (this.sealed) throw new Error('native chat event follows stream closure');
    if (record.identity?.attemptId !== this.attemptId || receipt.globalSequence <= this.sequence) {
      throw new Error('native chat projection has foreign or regressing authority');
    }
    if (this.terminal) throw new Error('native chat event follows terminal');
    const body = record.body;
    if (body.case === 'content') {
      const bytes = this.assembler.append(body.value);
      if (bytes) {
        if (body.value.kind === wire.EngineContentKindV1.TRANSCRIPT) {
          const text = decode(bytes);
          this.message.text(body.value.operationId, text, body.value.thinking);
          this.emit(body.value.thinking ? 'thinking' : 'text', { text,
            native_journal_sequence: receipt.globalSequence.toString() });
        } else {
          if (this.pending) throw new Error('native chat content was not consumed by its boundary');
          this.pending = { content: body.value, bytes };
        }
      }
    } else {
      this.assembler.assertComplete();
      if (body.case === 'providerStarted') {
        this.message.start(body.value.operationId);
      } else if (body.case === 'providerUsage') {
        this.message.setUsage(body.value.operationId, body.value.usage);
      } else if (body.case === 'providerCompleted') {
        this.message.finish('final_answer', body.value.operationId);
      } else if (body.case === 'capabilityBoundary') {
        const boundary = body.value;
        const input = this.takeContent(wire.EngineContentKindV1.TOOL_INPUT, boundary.toolUseId, boundary.inputSha256);
        if (!boundary.capabilityName || this.tools.has(boundary.toolUseId) || this.tools.size >= 256) {
          throw new Error('native chat tool boundary is duplicate, unnamed or exceeds the bound');
        }
        const args: unknown = JSON.parse(decode(input));
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('native tool input is not an object');
        const publicId = nativeToolUseId(this.attemptId, boundary.operationId, boundary.toolUseId);
        this.message.tool(boundary.operationId, { type: 'tool_use', id: publicId,
          name: boundary.capabilityName, input: args as Record<string, unknown> });
        this.tools.set(boundary.toolUseId, { name: boundary.capabilityName, publicId, started: false });
        this.emit('tool_call_start', { id: publicId, provider_tool_use_id: boundary.toolUseId, name: boundary.capabilityName, input: args });
      } else if (body.case === 'capabilityDispatchStarted') {
        this.message.finish('commentary');
        const tool = this.tools.get(body.value.toolUseId);
        if (!tool || tool.started) throw new Error('native tool dispatch has no unique boundary');
        tool.started = true;
      } else if (body.case === 'capabilityRefused') {
        this.message.finish('commentary');
        const refused = body.value;
        const tool = this.tools.get(refused.toolUseId);
        if (!tool || tool.started) throw new Error('native refusal contradicts the dispatch boundary');
        this.emit('tool_call_result', { id: tool.publicId, provider_tool_use_id: refused.toolUseId, name: tool.name, duration_ms: 0,
          result: { content: failureContent('failed', `capability_rejected:${refused.reasonCode}`), isError: true, error: { code: 'POLICY_DENIED', retryable: false } } });
        this.tools.delete(refused.toolUseId);
      } else if (body.case === 'capabilityTerminal') {
        const terminal = body.value;
        if (terminal.classification === wire.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN) this.uncertain = true;
        const tool = this.tools.get(terminal.toolUseId);
        if (!tool?.started) throw new Error('native tool result has no dispatch');
        const succeeded = terminal.classification === wire.EngineCapabilityTerminalClassificationV1.SUCCEEDED;
        const bytes = succeeded ? this.takeContent(wire.EngineContentKindV1.TOOL_RESULT,
          terminal.toolUseId, terminal.resultSha256) : undefined;
        if (bytes && BigInt(bytes.byteLength) !== terminal.resultBytes) throw new Error('native tool result length diverged');
        const result = bytes ? decodeResult(bytes, terminal)
          : { content: failureContent(terminal.classification === wire.EngineCapabilityTerminalClassificationV1.CANCELLED ? 'cancelled'
              : terminal.classification === wire.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN ? 'outcome_unknown' : 'failed', terminal.reasonCode), isError: true,
            ...(terminal.classification === wire.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN ? { effectOutcome: 'unknown' } : {}),
            error: { code: terminal.classification === wire.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN
              ? 'TOOL_OUTCOME_UNKNOWN' : terminal.reasonCode, retryable: false } };
        if ('extraUserMessageHex' in result) {
          decodeNativeToolUserMessage(result.extraUserMessageHex);
          const blocks = this.resolveToolUserMessage?.(result.extraUserMessageHex as string);
          const image = blocks?.find(block => block.type === 'image');
          if (image?.type === 'image') result.image = { mediaType: image.mediaType, base64: image.base64 };
        }
        this.emit('tool_call_result', { id: tool.publicId, provider_tool_use_id: terminal.toolUseId, name: tool.name, result,
          duration_ms: Number(terminal.durationMs), native_journal_sequence: receipt.globalSequence.toString() });
        if ('nativeGoal' in result && !result.isError) this.emit('goal_mutations_persisted', { toolUseIds: [tool.publicId] });
        if ('nativeTasks' in result && (!result.isError || tool.name === 'execute_tasks')) {
          const mutation = parseNativeTaskMutation(result.nativeTasks, tool.publicId, tool.name);
          this.emit('task_updated', { task_id: '__task_list__', patch: {} });
          this.emit('todos_updated', { todos: deriveTodosFromState(mutation.next) });
          if (tool.name === 'task_complete') {
            const finished = mutation.next?.tasks.find(t => t.id === mutation.expected?.current_task_id);
            if (finished && (finished.status === 'done' || finished.status === 'failed')) {
              this.emit('task_finished', { task_id: finished.id, status: finished.status, result: finished.result, finished_at: finished.finished_at });
            }
          }
        }
        if (tool.name === 'save_note' && !result.isError) this.emit('session_drive_changed', { kind: 'memory' });
        this.tools.delete(terminal.toolUseId);
      } else if (body.case === 'terminal') {
        if (this.pending) throw new Error('native terminal has unconfirmed content');
        this.message.finish(body.value.classification === wire.EngineTerminalClassificationV1.COMPLETED ? 'final_answer' : 'commentary',
          undefined, body.value.reasonCode === 'ipc_identity_budget');
        if ([...this.tools.values()].some(tool => tool.started)) this.uncertain = true;
        for (const [id, tool] of this.tools) this.emit('tool_call_result', { id: tool.publicId, provider_tool_use_id: id, name: tool.name,
          result: { content: body.value.reasonCode, isError: true, ...(tool.started ? { effectOutcome: 'unknown' } : {}),
            error: { code: tool.started ? 'TOOL_OUTCOME_UNKNOWN' : 'NOT_EXECUTED', retryable: false } } });
        this.tools.clear(); this.terminal = body.value;
      }
    }
    this.sequence = receipt.globalSequence;
  }

  private takeContent(kind: wire.EngineContentKindV1, toolUseId: string, expected: Uint8Array): Uint8Array {
    const pending = this.pending;
    if (!pending || pending.content.kind !== kind || pending.content.toolUseId !== toolUseId
      || createHash('sha256').update(pending.bytes).digest('hex') !== Buffer.from(expected).toString('hex')) {
      throw new Error('native tool content differs from its committed terminal or boundary');
    }
    this.pending = undefined;
    return pending.bytes;
  }
}

function decode(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function decodeResult(bytes: Uint8Array, terminal: wire.EngineCapabilityTerminalRecordV1): Record<string, unknown> {
  const schema = terminal.resultSchemaId, version = terminal.resultSchemaVersion;
  if (version !== 1 || !['codestudio.tool-result.v1', 'codestudio.agent.native-read-file-result.v1'].includes(schema)) {
    throw new Error('native tool result schema is unsupported by the chat projection');
  }
  const result: unknown = JSON.parse(decode(bytes));
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('content' in result)
    || typeof result.content !== 'string') throw new Error('native tool result content is invalid');
  // The durable terminal owns transport metadata. Dropping it changes the
  // provider conversation after replay, so a truncated read cannot resume.
  // Do not trust similarly named fields inside a tool's arbitrary payload.
  const projected: Record<string, unknown> = { ...result, isError: 'isError' in result ? result.isError : false };
  delete projected.truncated; delete projected.originalSize;
  if (terminal.truncated) {
    if (terminal.bytesRead > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('native tool original size is not representable');
    projected.truncated = true; projected.originalSize = Number(terminal.bytesRead);
  }
  return projected;
}

/** Matches the engine's provider_context/capability_result failure envelope. */
function failureContent(kind: string, reason: string): string {
  return JSON.stringify({ error: { kind, reason_code: reason } });
}
