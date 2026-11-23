import { readFileSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, type AtomicFileOptions } from './atomic-file.js';
import { materializeChapterMessage, packChapterLines, retireLegacyChapterPacks, type ChapterSpan } from './chapter-transcript.js';
import { readActiveChapterSpans } from './fs-store/conversation-chapter-codec.js';
import { projectConversation } from './fs-store/conversation-codec.js';
import type { FsCoderTurnPayload, FsStoredMessage } from './fs-store/types.js';
import { assertPathHasNoLinksSync, UnsafeSessionPathError } from './path-safety.js';
import { CHAT_TRANSCRIPT } from './session-journal-path.js';
import type { ConversationCommit, SessionState } from './types.js';

/** The public transcript can always be regenerated from the fenced journal and chapter checkpoints. */
export class ActiveChatTranscript {
  private boundary = 0;
  private chapters: ChapterSpan[] = [];
  private expectedBytes = 0;
  private readonly path: string;
  constructor(private readonly bundle: string, private readonly options: AtomicFileOptions) {
    this.path = join(bundle, CHAT_TRANSCRIPT);
  }
  checkpoints() {
    const statePath = join(this.bundle, 'state.json');
    assertPathHasNoLinksSync(this.bundle, statePath);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as SessionState;
    const chapters = readActiveChapterSpans(this.bundle);
    this.chapters = chapters;
    this.boundary = Math.max(Number(state.compaction?.boundary_seq) || 0, chapters[0]?.end_message_seq ?? 0);
    return chapters;
  }
  async encode(commit: ConversationCommit): Promise<string> {
    const line = JSON.stringify(commit);
    const turn = this.chatTurn(commit);
    if (!this.chapters.length || !turn || !(turn.messages.some(row => row.seq <= this.boundary) ||
        turn.message_patches.some(row => row.seq <= this.boundary) || turn.tool_calls.some(call => call.message_seq <= this.boundary))) {
      return line + '\n';
    }
    const lines = [line];
    await packChapterLines(this.bundle, this.chapters, lines, this.options);
    return lines[0] + '\n';
  }
  private render(rows: readonly FsStoredMessage[]): string {
    return rows.filter(r => r.seq > this.boundary).map(row => {
      // Attachments and tool results already have durable content-addressed bodies.
      // Keep their content blocks here without duplicating binary data or tool output.
      const { role, phase, content } = materializeChapterMessage(row);
      return JSON.stringify({ role, ...(phase ? { phase } : {}), content }) + '\n';
    }).join('');
  }
  async rebuild(records: readonly ConversationCommit[]) {
    const coder = records.filter(r => this.chatTurn(r) !== null);
    const next = this.render(projectConversation(coder).storedMessages);
    let current: string | undefined;
    try { assertPathHasNoLinksSync(this.bundle, this.path); current = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== next) {
      if (current) await retireLegacyChapterPacks(this.bundle, current, this.options.beforePublish);
      await atomicWriteFile(this.path, next, this.options);
    }
    this.expectedBytes = Buffer.byteLength(next);
  }
  async appended(record: ConversationCommit, records: readonly ConversationCommit[]) {
    const turn = this.chatTurn(record);
    if (!turn) return;
    if (turn.truncate_from_seq !== undefined || turn.message_patches.some(p => p.content !== undefined && p.seq > this.boundary)) {
      await this.rebuild(records);
      return;
    }
    const chunk = this.render(turn.messages);
    if (!chunk) return;
    const info = await lstat(this.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new UnsafeSessionPathError('Unsafe active chat transcript');
    if (info?.size !== this.expectedBytes) { await this.rebuild(records); return; }
    await this.options.beforePublish?.();
    const handle = await open(this.path, 'a', 0o600);
    try { await handle.writeFile(chunk); await handle.sync(); } finally { await handle.close(); }
    this.expectedBytes += Buffer.byteLength(chunk);
  }
  private chatTurn(record: ConversationCommit): FsCoderTurnPayload | null {
    const turn = record.payload as unknown as FsCoderTurnPayload;
    return turn?.type === 'coder.turn' && turn.schema_version === 1 ? turn : null;
  }
}
