import type { AgentMessage, ContentBlock, ImageBlock } from './messages.js';
import type { ToolContext } from './tool.js';

// Avoid hashing/stringifying historical base64 on every streamed tool iteration.
const references = new WeakMap<ImageBlock, { store: object; id: string }>();

/** Keep the durable transcript intact; send pixels only when the agent asks. */
export function projectVisionContext(messages: AgentMessage[], store: ToolContext['toolOutputStore']): AgentMessage[] {
  if (!store?.putImage) return messages; // Hosts without durable media keep legacy vision.
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') { lastAssistant = i; break; }
  }
  return messages.map((message, index) => {
    if (!message.content.some(block => block.type === 'image')) return message;
    const content = message.content.flatMap((block): ContentBlock[] => {
      if (block.type !== 'image' || !block.base64) return [block];
      const cached = references.get(block);
      const id = block.sourceImageId || (cached?.store === store ? cached.id : store.putImage!(block));
      if (!id) return [block];
      references.set(block, { store, id });
      const reference: ContentBlock = { type: 'text', text:
        `[Image ${JSON.stringify(block.name || 'image')}, attachment_id=${id}. ` +
        'Use view_image with this attachment_id to inspect/revisit it. ' +
        'view_image action=list lists saved images even after compaction.]' };
      return block.visionRequested && index > lastAssistant ? [reference, block] : [reference];
    });
    return { ...message, content };
  });
}
