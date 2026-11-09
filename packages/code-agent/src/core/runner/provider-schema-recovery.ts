import type { BehaviorEvent, RunContext } from './machine/types.js';

const EMPTY: ReadonlySet<string> = new Set();
const MAX_REJECTIONS_PER_PROVIDER = 4;
const providerKey = (ctx: RunContext): string => JSON.stringify([ctx.opts.provider.name, ctx.opts.provider.model]);

export function isToolSchemaRejection(message: string, code?: string): boolean {
  return /invalid[_ -](?:function[_ -]parameters|tool[_ -]schema)/i.test(code ?? '')
    || /invalid schema for (?:function|tool)\b/i.test(message);
}

export function rejectedProviderTools(ctx: RunContext): ReadonlySet<string> {
  return ctx.rejectedToolSchemas.get(providerKey(ctx)) ?? EMPTY;
}

/** Change the rejected request once; never spend network retries on it. */
export function recoverRejectedToolSchema(ctx: RunContext, event: Extract<BehaviorEvent, { kind: 'ProviderError' }>): boolean {
  if (!isToolSchemaRejection(event.message ?? '', event.code)) return false;
  const name = /invalid schema for (?:function|tool)\s+['"`]([a-zA-Z0-9_.-]{1,256})['"`]/i.exec(event.message ?? '')?.[1];
  // Only a declaration in the actual failed request may be removed. Unknown
  // names, nameless errors and repeated failures retain their real diagnostic.
  if (!name || !ctx.lastProviderToolNames.has(name)) return false;
  const key = providerKey(ctx);
  const rejected = ctx.rejectedToolSchemas.get(key) ?? new Set<string>();
  if (rejected.has(name) || rejected.size >= MAX_REJECTIONS_PER_PROVIDER) return false;
  rejected.add(name);
  ctx.rejectedToolSchemas.set(key, rejected);
  console.warn(`[coder] provider rejected schema for ${name}; continuing with other tool declarations`);
  return true;
}

export function toolSchemaRecoveryPrompt(ctx: RunContext): string {
  const rejected = rejectedProviderTools(ctx);
  if (!rejected.size) return '';
  return '\n<tool-schema-compatibility>\n' +
    `The current provider rejected the JSON schema declarations for: ${[...rejected].sort().join(', ')}. ` +
    'They are omitted from this run\'s provider requests. Continue the task with the remaining tools; ' +
    'repeated discovery or tier expansion will not repair these declarations. ' +
    'If code_exec is available, inspect tool_schema(name) there and use its tool bridge when appropriate. ' +
    'Execution still follows the same authorization and outcome-recovery rules. ' +
    'This declaration rejection did not execute the rejected tool.\n</tool-schema-compatibility>';
}
