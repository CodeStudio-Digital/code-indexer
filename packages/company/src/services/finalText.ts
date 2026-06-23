/**
 * Helpers for reading the final assistant message of a coder session.
 *
 * Shared between `SubordinateLifecycle` (which renders the master notice
 * after a subordinate completes) and `PipelineExecutor` (which captures
 * each node's final text as the input to the next node).
 *
 * Best-effort: callers should treat `null` as "no useful text" and fall
 * back to a generic message rather than failing.
 */

import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';

export function readFinalAssistantText(sessionId: number, tail = 3): string | null {
  try {
    const config = loadConfig();
    const store = new SessionStore(config.dbPath);
    try {
      const loaded = store.loadSessionMessagesTail(sessionId, tail);
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
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}
