import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { UnsafeSessionPathError } from './path-safety.js';

export const CODER_JOURNAL = 'journal.jsonl';
export const CHAT_TRANSCRIPT = 'conversation.jsonl';

/** The publication of journal.jsonl switches the bundle from the legacy format. */
export function sessionJournalPath(bundle: string): string {
  const journal = join(bundle, CODER_JOURNAL);
  const file = lstatSync(journal, { throwIfNoEntry: false });
  if (!file) return join(bundle, CHAT_TRANSCRIPT);
  if (!file.isFile() || file.isSymbolicLink()) throw new UnsafeSessionPathError(`Unsafe session journal: ${journal}`);
  return journal;
}
