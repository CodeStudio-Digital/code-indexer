import type { RunContext } from './machine/types.js';
import { unresolvedToolOutcomes } from '../uncertain-tool-outcome.js';

/** Synchronize typed evidence before bootstrap or an automatic inspection turn. */
export async function synchronizeOutcomeRecovery(ctx: RunContext, currentToolUseIds: readonly string[] = []): Promise<void> {
  const recovery = ctx.opts.toolContext.outcomeRecovery;
  await recovery?.refresh?.();
  const resolved = new Set(recovery?.resolvedToolUseIds ?? []);
  const pending = [...new Set([
    ...(recovery?.toolUseIds ?? []),
    ...unresolvedToolOutcomes(ctx.opts.initialMessages ?? []),
    ...unresolvedToolOutcomes(ctx.messages),
  ])].filter(id => !resolved.has(id));
  let supplemental = pending.filter(id => !recovery?.toolUseIds.includes(id));
  if (recovery?.authoritative && supplemental.length && recovery.registerIncident) {
    const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
    for (const message of [...(ctx.opts.initialMessages ?? []), ...ctx.messages]) {
      if (message.role !== 'assistant') continue;
      for (const block of message.content) if (block.type === 'tool_use') uses.set(block.id, block);
    }
    for (const id of supplemental) {
      const use = uses.get(id);
      const live = currentToolUseIds.includes(id);
      await recovery.registerIncident({ toolUseId: id, toolName: use?.name ?? 'unknown', args: use?.input ?? {},
        ...(live ? { runId: ctx.runId } : {}),
        sourceReference: live ? `runner:${ctx.runId}:${id}`
          : `bootstrap:${ctx.opts.toolContext.sessionId ?? ctx.opts.toolContext.projectName}:history:${id}` });
    }
    supplemental = supplemental.filter(id => !recovery.toolUseIds.includes(id) && !recovery.resolvedToolUseIds?.includes(id));
  }
  if (recovery?.authoritative && supplemental.length) {
    // Imported evidence must never be erased by the parent's smaller store.
    ctx.opts.toolContext.outcomeRecovery = {
      ...recovery,
      get toolUseIds() { return [...new Set([...recovery.toolUseIds,
        ...supplemental.filter(id => !recovery.resolvedToolUseIds?.includes(id))])]; },
      get resolvedToolUseIds() { return recovery.resolvedToolUseIds; },
      replayToolUseIds: (name, input) => [...new Set([...(recovery.replayToolUseIds?.(name, input) ?? recovery.toolUseIds),
        ...supplemental.filter(id => !recovery.resolvedToolUseIds?.includes(id))])],
    };
  } else if (pending.length && !recovery?.authoritative) {
    ctx.opts.toolContext.outcomeRecovery = Object.freeze({ toolUseIds: Object.freeze(pending) });
  }
}
