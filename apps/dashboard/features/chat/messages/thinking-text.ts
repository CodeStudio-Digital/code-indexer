/** Normalize provider reasoning summaries before rendering them in the chat UI. */

export function cleanThinkingMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function thinkingPreviewText(text: string): string {
  return cleanThinkingMarkdown(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~#>`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
