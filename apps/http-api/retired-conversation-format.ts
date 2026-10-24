import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asSessionId } from '@mcp/session-storage';

const RETIRED_CONVERSATION_FORMAT_CODE = 'RETIRED_CONVERSATION_FORMAT';

export class RetiredConversationFormatError extends Error {
  readonly code = RETIRED_CONVERSATION_FORMAT_CODE;

  constructor() {
    super('This conversation uses a retired runtime format. Start a new conversation.');
    this.name = 'RetiredConversationFormatError';
  }
}

export function isRetiredConversationFormatError(error: unknown): error is RetiredConversationFormatError {
  return error instanceof RetiredConversationFormatError;
}

/**
 * Older conversations can have a separate authoritative journal. Their base
 * transcript is incomplete, so it cannot safely be read or continued as a
 * current conversation. Only inspect the format marker; preserve all data.
 */
export async function assertSupportedConversationFormat(dbPath: string, sessionId: string): Promise<void> {
  const canonicalSessionId = asSessionId(sessionId);
  const markerPath = join(dirname(dbPath), 'native-sessions', canonicalSessionId, 'session.json');
  try {
    await lstat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new RetiredConversationFormatError();
}
