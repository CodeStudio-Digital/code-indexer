import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtomicFileOptions } from './atomic-file.js';
import { assertPathHasNoLinksSync } from './path-safety.js';
import { isDigest, transcriptDigest, writeTranscriptFile } from './transcript-files.js';
import { isUuid, type ConversationCommit } from './types.js';

interface RecordRange { chapter: string; file: string; offset: number; length: number; sha256: string }
export type JournalLine = ConversationCommit | { chapter_record: RecordRange };
function pathFor(bundle: string, chapter: string, file: string) {
  if (!isUuid(chapter) || !isDigest(file)) throw new Error('Invalid chapter journal path');
  return join(bundle, 'chapters', chapter, 'records-' + file + '.ndjson');
}

export class ChapterRecordReader {
  private lastRecordFile?: { path: string; bytes: Buffer };
  resolve(bundle: string, line: JournalLine): ConversationCommit {
    if (!('chapter_record' in line)) return line;
    const r = line.chapter_record;
    const path = pathFor(bundle, r.chapter, r.file);
    if (!isDigest(r.sha256) || !Number.isSafeInteger(r.offset) || r.offset < 0 ||
        !Number.isSafeInteger(r.length) || r.length < 1 || !Number.isSafeInteger(r.offset + r.length)) {
      throw new Error('Invalid chapter journal range');
    }
    if (this.lastRecordFile?.path !== path) {
      assertPathHasNoLinksSync(bundle, path);
      this.lastRecordFile = { path, bytes: readFileSync(path) };
    }
    const bytes = this.lastRecordFile.bytes.subarray(r.offset, r.offset + r.length);
    if (bytes.length !== r.length || transcriptDigest(bytes) !== r.sha256) throw new Error('Chapter journal checksum mismatch');
    return JSON.parse(bytes.toString('utf8')) as ConversationCommit;
  }
}

export async function packChapterRecords(bundle: string, chapter: string, rows: Map<number, string>, lines: string[], options: AtomicFileOptions) {
  const bytes = Buffer.from([...rows.values()].join('\n') + '\n');
  const file = transcriptDigest(bytes);
  await writeTranscriptFile(bundle, pathFor(bundle, chapter, file), bytes, file, options);
  let offset = 0;
  for (const [i, row] of rows) {
    const length = Buffer.byteLength(row);
    lines[i] = JSON.stringify({ chapter_record: { chapter, file, offset, length, sha256: transcriptDigest(row) } });
    offset += length + 1;
  }
}
