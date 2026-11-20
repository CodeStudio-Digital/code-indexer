import { err, type CoderTool } from '../core/tool.js';
import { okStructured } from '../core/model-output.js';
import type { ChatTrigger } from '@mcp/session-storage/collaboration/network-types.js';

const str = { type: 'string' };
// Discovery, reading and creation moved to the child-chat tools (list_chats, read_chat, create_chat).
const definitions: Array<Omit<CoderTool, 'handler' | 'source'>> = [
  { name: 'create_chat_trigger', description: 'In agentic mode, wake a linked target chat once when a linked source chat next completes/fails/finishes. May include its final answer. Survives host restart; does not poll an LLM or rerun on the same completion. Use distinct source and target chats.', parameters: { type: 'object', properties: { sourceSessionId: str, targetSessionId: str, event: { type: 'string', enum: ['completed', 'failed', 'finished'] }, prompt: str, includeFinal: { type: 'boolean' } }, required: ['sourceSessionId', 'targetSessionId', 'event', 'prompt', 'includeFinal'], additionalProperties: false } },
];
export const sessionNetworkTools: CoderTool[] = definitions.map((definition) => ({
  ...definition, source: 'native', mutates: false, riskLevel: 'read', effectBoundary: 'control', executionClass: 'control', parallelSafe: false, repeatPolicy: 'volatile',
  handler: async (args, ctx) => {
    if (!ctx.sessionNetwork || !ctx.sessionId || ctx.companyContext) return err('Ordinary session collaboration is unavailable');
    try {
      return okStructured(await ctx.sessionNetwork.trigger(ctx.sessionId, args as unknown as Pick<ChatTrigger, 'sourceSessionId' | 'targetSessionId' | 'event' | 'prompt' | 'includeFinal'>, ctx.currentToolUseId ?? ''));
    } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
  },
}));
