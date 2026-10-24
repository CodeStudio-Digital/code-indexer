import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPathHasNoLinks, type SessionId } from '@mcp/session-storage';
import type { FsConversationChapterRepository } from './conversation-chapter-repository.js';
import type { FsSessionDirectory } from './session-directory.js';
import type { FsConversationChapterRow } from './history-metrics-types.js';

export interface ChapterIndex {
  total: number;
  entries: Array<Pick<FsConversationChapterRow, 'id' | 'ordinal' | 'title' | 'source'>>;
}

/** Rebuildable titles-only projection. Revisions include every file's identity
 * and timestamps, so atomic replacement, deletion and in-place edits expire it. */
export class FsConversationChapterIndex {
  private readonly cache = new Map<string, { revision: string; value: ChapterIndex }>();

  constructor(private readonly directory: FsSessionDirectory, private readonly chapters: FsConversationChapterRepository) {}

  async get(sessionId: SessionId | string): Promise<ChapterIndex> {
    const entry = await this.directory.requireEntry(sessionId);
    const root = join(entry.location.bundle_path, 'chapters');
    await assertPathHasNoLinks(entry.location.bundle_path, root);
    const revision = await this.revision(root);
    const cached = this.cache.get(root);
    if (cached?.revision === revision) return structuredClone(cached.value);
    const page = await this.chapters.list(sessionId, { limit: 10 });
    const value: ChapterIndex = {
      total: page.total_count ?? await this.chapters.count(sessionId),
      entries: page.items.map(({ id, ordinal, title, source }) => ({ id, ordinal, title, source })),
    };
    // Never cache a list captured across a concurrent chapter commit.
    if (revision === await this.revision(root)) {
      this.cache.delete(root);
      this.cache.set(root, { revision, value });
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
    }
    return structuredClone(value);
  }

  private async revision(root: string): Promise<string> {
    const names = (await readdir(root)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).sort();
    const hash = createHash('sha256');
    for (let offset = 0; offset < names.length; offset += 16) {
      const metadata = await Promise.all(names.slice(offset, offset + 16).map(async name => {
        const stat = await lstat(join(root, name), { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('chapter index source is not a regular file');
        return `${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}\n`;
      }));
      for (const stamp of metadata) hash.update(stamp);
    }
    return hash.digest('hex');
  }
}
