import { JsonRpcApplicationError } from './JsonRpcPeer.js';
import {
  asRecord,
  bindId,
  BYPASS_ITEM_TYPES,
  CODESTUDIO_NAMESPACE,
  emit,
  engineEvent,
  isRecord,
  nestedId,
  optionalText,
  requireBoundId,
  type RunState,
  terminalStatus,
  textField,
  validateCorrelation,
  validateCorrelationIfPresent,
  validateThread,
} from './CodexAppServerSupport.js';
import type {
  OssEngineAttemptSpec,
  OssEngineClockPort,
  OssEngineEventSink,
  OssEngineToolHostPort,
} from './types.js';
import { type OssEngineValidationLimits, validateToolReceipt } from './validation.js';

interface HandlerContext {
  spec: OssEngineAttemptSpec;
  state: RunState;
  sink: OssEngineEventSink;
  clock: OssEngineClockPort;
}

interface RequestContext extends HandlerContext {
  aliases: ReadonlyMap<string, OssEngineAttemptSpec['capabilities'][number]>;
  toolHost: OssEngineToolHostPort;
  limits: OssEngineValidationLimits;
}

export async function handleCodexNotification(
  method: string,
  paramsValue: unknown,
  context: HandlerContext,
): Promise<void> {
  const { spec, state, sink, clock } = context;
  const params = isRecord(paramsValue) ? paramsValue : {};
  if (method === 'thread/started') {
    state.threadId = bindId(state.threadId, nestedId(params, 'thread'), 'thread');
    return;
  }
  if (method === 'turn/started') {
    validateThread(params, state);
    state.turnId = bindId(state.turnId, nestedId(params, 'turn'), 'turn');
    if (!state.turnStartedEmitted) {
      state.turnStartedEmitted = true;
      await emit(sink, engineEvent(spec, clock.now(), 'turn_started', state));
    }
    return;
  }
  if (method === 'turn/completed') {
    validateThread(params, state);
    const turn = asRecord(params.turn, 'turn_completed_invalid');
    state.turnId = bindId(state.turnId, textField(turn, 'id'), 'turn');
    const status = terminalStatus(turn.status);
    await emit(sink, engineEvent(spec, clock.now(), 'turn_terminal', state, { status }));
    state.terminal.resolve(status);
    return;
  }
  if (method === 'item/started') {
    validateCorrelationIfPresent(params, state);
    const item = isRecord(params.item) ? params.item : undefined;
    if (item && typeof item.type === 'string' && BYPASS_ITEM_TYPES.has(item.type)) {
      state.observedBypassToolCount += 1;
      await emit(sink, engineEvent(spec, clock.now(), 'warning', state, {
        status: 'candidate_tool_bypassed_tool_host',
        details: { itemType: item.type },
      }));
    }
    return;
  }
  if (method === 'item/agentMessage/delta') {
    await emitDelta('agent_message_delta', params, context);
    return;
  }
  if (method.startsWith('item/reasoning/') && method.endsWith('Delta')) {
    await emitDelta('reasoning_delta', params, context);
    return;
  }
  if (method === 'warning' || method === 'configWarning' || method === 'error') {
    validateCorrelationIfPresent(params, state);
    const text = optionalText(params.message) ?? optionalText(params.summary) ?? 'Codex warning';
    await emit(sink, engineEvent(spec, clock.now(), 'warning', state, { text }));
  }
}

export async function handleCodexRequest(
  method: string,
  paramsValue: unknown,
  signal: AbortSignal,
  context: RequestContext,
): Promise<unknown> {
  const params = asRecord(paramsValue, 'server_request_params_invalid');
  validateCorrelation(params, context.state);
  if (method === 'item/tool/call') {
    return invokeDynamicTool(params, signal, context);
  }
  if (method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval') {
    await recordDeniedRequest(method, context);
    return { decision: 'decline' };
  }
  if (method === 'item/permissions/requestApproval') {
    await recordDeniedRequest(method, context);
    return { scope: 'turn', permissions: {} };
  }
  if (method === 'mcpServer/elicitation/request') {
    context.state.deniedBuiltInRequestCount += 1;
    return { action: 'decline', content: null };
  }
  throw new JsonRpcApplicationError(-32601, `Unsupported server request ${method}`);
}

async function invokeDynamicTool(
  params: Record<string, unknown>,
  signal: AbortSignal,
  context: RequestContext,
): Promise<unknown> {
  const { spec, state, aliases, sink, clock, toolHost, limits } = context;
  if (textField(params, 'namespace') !== CODESTUDIO_NAMESPACE) {
    throw new JsonRpcApplicationError(-32602, 'Dynamic tool namespace is not authorized');
  }
  const alias = textField(params, 'tool');
  const capability = aliases.get(alias);
  if (!capability) {
    throw new JsonRpcApplicationError(-32602, `Dynamic tool ${alias} is outside the attempt snapshot`);
  }
  const callId = textField(params, 'callId');
  const args = asRecord(params.arguments, 'dynamic_tool_arguments_invalid');
  const receipt = await toolHost.invoke({
    authority: spec.authority,
    threadId: requireBoundId(state.threadId, 'thread'),
    turnId: requireBoundId(state.turnId, 'turn'),
    callId,
    capability,
    arguments: args,
  }, signal);
  validateToolReceipt(receipt, callId, limits.maxToolResultBytes);
  state.toolCallCount += 1;
  await emit(sink, engineEvent(spec, clock.now(), 'tool_call_terminal', state, {
    callId,
    status: receipt.outcome,
    details: { capabilityId: capability.capabilityId, mutates: capability.mutates },
  }));
  return { contentItems: [...receipt.contentItems], success: receipt.outcome === 'completed' };
}

async function emitDelta(
  kind: 'agent_message_delta' | 'reasoning_delta',
  params: Record<string, unknown>,
  context: HandlerContext,
): Promise<void> {
  validateCorrelationIfPresent(params, context.state);
  const text = optionalText(params.delta) ?? optionalText(params.text);
  if (!text) return;
  context.state.firstDeltaAt ??= context.clock.now();
  await emit(context.sink, engineEvent(context.spec, context.clock.now(), kind, context.state, { text }));
}

async function recordDeniedRequest(method: string, context: RequestContext): Promise<void> {
  context.state.deniedBuiltInRequestCount += 1;
  await emit(context.sink, engineEvent(context.spec, context.clock.now(), 'built_in_request_denied', context.state, {
    details: { method },
  }));
}
