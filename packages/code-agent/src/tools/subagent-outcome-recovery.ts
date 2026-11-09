import { createHash } from 'node:crypto';
import type { AgentMessage } from '../core/messages.js';
import type { OutcomeRecoveryIncident, OutcomeRecoveryState } from '../core/outcome-recovery-state.js';
import type { ToolContext } from '../core/tool.js';
import { uncertainToolOutcomeError } from '../core/uncertain-tool-outcome.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The child has a checkpoint, not a separate FsSessionStore. Host-typed
 * incidents therefore live in the parent's journal under an isolated ID.
 * Only this facade aliases those IDs back to the child's provider history. */
export async function createSubagentOutcomeRecovery(options: {
  parent: ToolContext['outcomeRecovery'];
  onTerminal: ToolContext['onToolOutcomeTerminal'];
  sourceReference: string;
  initialMessages: readonly AgentMessage[];
  getRunId: () => string | undefined;
}) {
  const parent = options.parent;
  const prefix = `child:${digest(options.sourceReference)}:`;
  const aliases = new Map<string, string>();
  const unregistered = new Map<string, OutcomeRecoveryIncident>();
  let pending: Promise<void> = Promise.resolve();
  let failedId: string | undefined;
  const qualify = (rawId: string): string => {
    const id = prefix + digest(rawId);
    aliases.set(rawId, id);
    return id;
  };
  const register = async (input: { toolUseId: string; toolName: string; args: Record<string, unknown>; runId?: string }, legacy: boolean): Promise<void> => {
    const id = qualify(input.toolUseId);
    // A resume replays the checkpoint's typed audit history, not a new effect.
    // Do not manufacture a fresh incident after the host already reviewed it.
    if (legacy && (parent?.toolUseIds.includes(id) || parent?.resolvedToolUseIds?.includes(id))) return;
    unregistered.set(id, { toolUseId: id, toolName: input.toolName,
      argsSummary: JSON.stringify(input.args).slice(0, 600) });
    if (!parent?.registerIncident) return; // Ad-hoc hosts remain fail-closed.
    try {
      await parent.registerIncident({ ...input, toolUseId: id,
        sourceReference: `${options.sourceReference}/${legacy ? 'legacy' : `run/${input.runId ?? 'unknown'}`}/call/${digest(input.toolUseId)}` });
      unregistered.delete(id);
    } catch {
      failedId = id;
      throw uncertainToolOutcomeError(id);
    }
  };

  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const message of options.initialMessages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use') {
        uses.set(block.id, { name: block.name, input: block.input });
      } else if (message.role === 'tool' && block.type === 'tool_result' && block.effect_outcome === 'unknown') {
        const use = uses.get(block.tool_use_id);
        await register({ toolUseId: block.tool_use_id, toolName: use?.name ?? 'unknown', args: use?.input ?? {} }, true);
      }
    }
  }

  const withAliases = (ids: readonly string[]): string[] => {
    const result = new Set(ids);
    for (const [raw, id] of aliases) if (result.has(id)) result.add(raw);
    return [...result];
  };
  const state: OutcomeRecoveryState = {
    authoritative: true,
    get toolUseIds() { return withAliases([...(parent?.toolUseIds ?? []), ...unregistered.keys()]); },
    get resolvedToolUseIds() {
      const resolved = parent?.resolvedToolUseIds ?? [];
      // A parent's unrelated provider call may reuse the child's raw ID. Only
      // resolution of THIS namespace can resolve the child's audit block.
      return withAliases(resolved.filter(id => !unregistered.has(id)
        && (!aliases.has(id) || resolved.includes(aliases.get(id)!))));
    },
    refresh: async () => { await pending; await parent?.refresh?.(); },
    ...(parent?.subscribe ? { subscribe: parent.subscribe.bind(parent) } : {}),
    // Grandchildren use their own namespace and the same durable host channel.
    ...(parent?.registerIncident ? { registerIncident: parent.registerIncident.bind(parent) } : {}),
    replayToolUseIds: (name, input) => withAliases([
      ...(parent?.replayToolUseIds?.(name, input) ?? parent?.toolUseIds ?? []), ...unregistered.keys(),
    ]),
    snapshot: () => {
      const snapshot = parent?.snapshot?.();
      if (!unregistered.size) return snapshot ?? { fingerprint: digest('empty'), incidents: [] };
      // Missing persistence is never presented as a recoverable durable review.
      return { fingerprint: digest(JSON.stringify([snapshot?.fingerprint, [...unregistered.keys()]])),
        incidents: [...(snapshot?.incidents ?? []), ...unregistered.values()] };
    },
  };

  return {
    state,
    qualify,
    onTerminal: ((receipt, originRunId = undefined) => {
      // A descendant already translated its receipt and bound its run. Passing
      // through another facade must not add a second namespace.
      if (originRunId) return options.onTerminal?.(receipt, originRunId);
      return options.onTerminal?.({ ...receipt, toolUseId: qualify(receipt.toolUseId),
        ...(receipt.parentToolUseId ? { parentToolUseId: qualify(receipt.parentToolUseId) } : {}),
      }, options.getRunId());
    }) satisfies NonNullable<ToolContext['onToolOutcomeTerminal']>,
    recordUnknown(input: { toolUseId: string; toolName: string; args: Record<string, unknown>; runId: string }): void {
      // Retain failures until the terminal checkpoint boundary; the synchronous
      // event emitter must not create an unhandled rejection or report success.
      pending = pending.then(() => register(input, false)).catch(() => { failedId ??= qualify(input.toolUseId); });
    },
    async drain(): Promise<void> {
      await pending;
      if (failedId) throw uncertainToolOutcomeError(failedId);
    },
  };
}
