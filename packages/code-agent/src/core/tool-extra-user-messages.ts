import type { AgentMessage, ContentBlock } from './messages.js';

/** Only harness-generated approval reminders are internal. User input and
 * attachments from other tools retain their normal visibility. */
export function isInternalToolReminder(name: string | undefined, blocks: readonly ContentBlock[]): boolean {
  return ['submit_plan', 'submit_spec', 'execute_tasks'].includes(name ?? '') && blocks.length > 0
    && blocks.every(block => block.type === 'text' && block.text.trim().startsWith('<system-reminder>')
      && block.text.trim().endsWith('</system-reminder>'));
}

/** Keep call order and image visibility when a batch mixes reminders and attachments. */
export function toolExtraUserMessages(results: readonly { name: string; extraUserBlocks?: ContentBlock[] }[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const result of results) {
    const blocks = result.extraUserBlocks?.map(block => block.type === 'image'
      ? { ...block, visionRequested: true as const } : block);
    if (!blocks?.length) continue;
    const isMeta = isInternalToolReminder(result.name, blocks);
    const previous = messages.at(-1);
    if (previous && !!previous.isMeta === isMeta) previous.content.push(...blocks);
    else messages.push({ role: 'user', content: [...blocks], ...(isMeta ? { isMeta: true } : {}) });
  }
  for (const message of messages) {
    if (message.content.some(block => block.type === 'image')) {
      message.content.push({ type: 'text', text: '(Image(s) attached from the tool call above.)' });
    }
  }
  return messages;
}
