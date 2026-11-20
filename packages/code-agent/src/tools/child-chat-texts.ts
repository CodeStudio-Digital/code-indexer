/**
 * The child-chat versions of model-visible tool texts that name or describe
 * the tools child chats replace (spawn_agent and its companions). runCoder
 * applies them only with child chats on, by revising the registered tools;
 * with the switch off every text stays exactly as it was. (The code_exec
 * hint keeps its own child-chat example, to stay out of an import cycle.)
 */
import type { CoderTool } from '../core/tool.js';
import { CODE_EXEC_CATALOG_DESCRIPTION } from './catalog-contracts.js';
import { WORKFLOW_DESC } from './workflow/workflow-schema.js';

function replaced(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`child-chat text: "${from}" is no longer in the source text`);
  return text.replace(from, to);
}

const CHILD_CHAT_TEXTS: Readonly<Record<string, Pick<CoderTool, 'description' | 'catalogDescription'> | Pick<CoderTool, 'catalogDescription'>>> = {
  code_exec: { catalogDescription: replaced(CODE_EXEC_CATALOG_DESCRIPTION,
    'Interactive, spawn/resume, lifecycle and image/video tools', 'Interactive, delegation (create_chat, send_chat_message), lifecycle and image/video tools') },
  workflow: { description: replaced(WORKFLOW_DESC, "DON'T: wrap a single task — do it in this session.", "DON'T: wrap a single task — use create_chat.") },
};

/** The tool with its child-chat texts, or the same tool when none of its texts change. */
export function withChildChatTexts(tool: CoderTool): CoderTool {
  const texts = CHILD_CHAT_TEXTS[tool.name];
  return texts ? { ...tool, ...texts } : tool;
}
