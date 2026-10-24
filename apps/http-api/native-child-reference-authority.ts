import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { isTerminalAgentRunStatus } from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { nativeTreeId, type NativeTreeData, type NativeParentState } from './native-child-admission.js';
import { parseNativeChildTranscriptRef } from './native-child-storage.js';

export interface NativeChildCompletionAuthority {
  context: ControlPlaneRunContext;
  status: string;
  reason: string;
  physicalReaped: boolean;
  hostDrained: boolean;
}

/** Resolves an exact durable reservation, including after worker recreation.
 * The reference identifies a journal; it never grants permission to read it. */
export async function resolveNativeChildReference(repository: ControlPlaneFileRepository, owner: ControlPlaneRunContext,
  reference: string, assertContext: (context: ControlPlaneRunContext, active: boolean) => Promise<NativeParentState>, requireActiveOwner = true) {
  const target = parseNativeChildTranscriptRef(reference);
  if (target.sessionId !== owner.sessionId) throw new Error('Native child transcript belongs to another session');
  const caller = await assertContext(owner, requireActiveOwner);
  if (!requireActiveOwner && caller.run.parentAgentRunId) throw new Error('Inactive transcript reads require a session root');
  const data = (await repository.get('nativeTree', nativeTreeId(target.rootAttemptId)))?.data as unknown as NativeTreeData | undefined;
  if (data?.checkpointType !== 'native-tree-v1' || data.rootAttemptId !== target.rootAttemptId
    || !Array.isArray(data.children) || data.children.length > 255) throw new Error('Native child transcript has no durable tree');
  const receipt = data.children.find(child => child.context.agentRunId === target.agentRunId && child.context.attemptId === target.attemptId);
  if (!receipt || receipt.context.sessionId !== owner.sessionId
    || hashControlPlanePayload(receipt.context.actor) !== hashControlPlanePayload(owner.actor)
    || receipt.requestHash !== hashControlPlanePayload(receipt.request)
    || receipt.run.ownerAgentRunId !== data.rootAgentRunId || receipt.run.agentRunId !== target.agentRunId) {
    throw new Error('Native child transcript is not owned by this session actor');
  }
  if (caller.run.parentAgentRunId) {
    // A child may inspect descendants it delegated, never another sibling's tree.
    const seen = new Set<string>(); let parentId = receipt.run.parentAgentRunId;
    while (parentId !== owner.agentRunId && parentId) {
      if (seen.has(parentId) || seen.size >= 32) throw new Error('Native child transcript ancestry is invalid');
      seen.add(parentId); parentId = data.children.find(child => child.run.agentRunId === parentId)?.run.parentAgentRunId;
    }
    if (parentId !== owner.agentRunId || receipt.context.commandId !== owner.commandId) {
      throw new Error('Native child transcript belongs to another branch');
    }
  } else if (caller.command.agentRunId !== owner.agentRunId || caller.run.spawnDepth !== 0) {
    throw new Error('Native child transcript reader is not a root or descendant owner');
  }
  const source = await assertContext(receipt.context, false);
  if (!isTerminalAgentRunStatus(source.run.status) || source.run.parentAgentRunId !== receipt.run.parentAgentRunId
    || source.run.ownerAgentRunId !== data.rootAgentRunId) throw new Error('Native child transcript has no matching terminal execution');
  await assertContext(owner, requireActiveOwner);
  return structuredClone(receipt.context);
}
