import type { SideChatSelection } from '@mcp/shared/side-chat.js';

export interface OpenSideChat {
  key: string;
  parentId: string;
  question?: string;
  selection?: SideChatSelection;
}

export function sideChatQuestion(input: string): string | undefined {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  return match ? (match[1] ?? '').trim() : undefined;
}
