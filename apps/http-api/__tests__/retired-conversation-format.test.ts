import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSupportedConversationFormat,
  isRetiredConversationFormatError,
  RetiredConversationFormatError,
} from '../retired-conversation-format.js';

const sessionId = 'aabbccdd-0000-4000-8000-000000000001';

describe('retired conversation format guard', () => {
  let dataDir: string;
  let dbPath: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'retired-conversation-format-'));
    dbPath = join(dataDir, 'store.db');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('permits conversations without a retired format marker', async () => {
    await expect(assertSupportedConversationFormat(dbPath, sessionId)).resolves.toBeUndefined();
  });

  it('rejects an existing marker without reading, converting, or changing the journal', async () => {
    const directory = join(dataDir, 'native-sessions', sessionId);
    await mkdir(directory, { recursive: true });
    const markerPath = join(directory, 'session.json');
    const journalPath = join(directory, 'journal.jsonl');
    await writeFile(markerPath, 'retained marker, even if malformed');
    await writeFile(journalPath, 'retained authoritative journal');

    await expect(assertSupportedConversationFormat(dbPath, sessionId.toUpperCase())).rejects.toMatchObject({
      code: 'RETIRED_CONVERSATION_FORMAT',
      message: 'This conversation uses a retired runtime format. Start a new conversation.',
    });
    expect(await readFile(markerPath, 'utf8')).toBe('retained marker, even if malformed');
    expect(await readFile(journalPath, 'utf8')).toBe('retained authoritative journal');
  });

  it('rejects non-UUID identities before constructing a filesystem path', async () => {
    await expect(assertSupportedConversationFormat(dbPath, '../other-session')).rejects.toThrow('canonical UUID');
  });

  it('distinguishes the format error from ordinary failures', () => {
    expect(isRetiredConversationFormatError(new RetiredConversationFormatError())).toBe(true);
    expect(isRetiredConversationFormatError(new Error('filesystem unavailable'))).toBe(false);
  });
});
