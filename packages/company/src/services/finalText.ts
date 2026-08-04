/**
 * Helpers for reading the final assistant message of a coder session.
 *
 * Shared by `SubordinateLifecycle`, which renders the master notice after a
 * subordinate completes.
 *
 * Best-effort: callers should treat `null` as "no useful text" and fall
 * back to a generic message rather than failing.
 */

import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';

export async function readFinalAssistantText(
  sessionStore: FsSessionStore,
  sessionId: string,
  tail = 3,
): Promise<string | null> {
  try {
    const loaded = await sessionStore.loadSessionMessagesTail(sessionId, tail);
    if (!loaded) return null;
    for (let i = loaded.messages.length - 1; i >= 0; i--) {
      const msg = loaded.messages[i];
      if (msg.role !== 'assistant') continue;
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } =>
          (b as { type?: string }).type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  }
}
