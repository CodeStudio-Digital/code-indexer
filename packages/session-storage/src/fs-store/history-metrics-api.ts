import type { SessionId } from '@mcp/session-storage';
import { FsCompactionAttemptRepository } from './compaction-attempt-repository.js';
import { FsConversationChapterRepository } from './conversation-chapter-repository.js';
import { FsConversationChapterIndex } from './conversation-chapter-index.js';
import { FsSessionEntityFiles } from './entity-files.js';
import type {
  FsCommitConversationChapterInput,
  FsFinishCompactionAttemptInput,
  FsRebuiltConversationChapterInput,
  FsRecordProviderAttemptInput,
  FsStartCompactionAttemptInput,
} from './history-metrics-types.js';
import { FsProviderAttemptRepository } from './provider-attempt-repository.js';
import { FsSessionDirectory } from './session-directory.js';
import type { FsConversationReader } from './conversation-reader.js';

class FsHistoryMetricsServices {
  readonly chapters: FsConversationChapterRepository;
  readonly chapterIndex: FsConversationChapterIndex;
  readonly compactions: FsCompactionAttemptRepository;
  readonly providerAttempts: FsProviderAttemptRepository;

  constructor(directory: FsSessionDirectory, reader?: FsConversationReader) {
    const entities = new FsSessionEntityFiles(directory);
    this.chapters = new FsConversationChapterRepository(
      directory,
      entities,
      reader,
    );
    this.compactions = new FsCompactionAttemptRepository(
      directory,
      entities,
      this.chapters,
      reader,
    );
    this.providerAttempts = new FsProviderAttemptRepository(entities);
    this.chapterIndex = new FsConversationChapterIndex(directory, this.chapters);
  }
}

class FsHistoryMetricsOperations {
  constructor(readonly services: FsHistoryMetricsServices) {}

  commitConversationChapter = (
    input: FsCommitConversationChapterInput,
  ) => this.services.chapters.commit(input);

  insertRebuiltConversationChapters = (
    id: SessionId | string,
    input: readonly FsRebuiltConversationChapterInput[],
  ) => this.services.chapters.insertRebuilt(id, input);

  listConversationChapters = (
    id: SessionId | string,
    options?: {
      limit?: number;
      cursor?: string | null;
      includeSuperseded?: boolean;
    },
  ) => this.services.chapters.list(id, options);

  countConversationChapters = (
    id: SessionId | string,
    includeSuperseded?: boolean,
  ) => this.services.chapters.count(id, includeSuperseded);

  getConversationChapterIndex = (id: SessionId | string) => this.services.chapterIndex.get(id);

  searchConversationChapters = (
    id: SessionId | string,
    query: string,
    options?: { limit?: number; cursor?: string | null },
  ) => this.services.chapters.search(id, query, options);

  getConversationChapter = (
    id: SessionId | string,
    chapterId: string,
  ) => this.services.chapters.get(id, chapterId);

  listConversationChapterSource = (
    id: SessionId | string,
    chapterId: string,
    options?: { limit?: number; cursor?: string | null },
  ) => this.services.chapters.listSource(id, chapterId, options);

  getConversationChapterMessages =
    this.listConversationChapterSource;

  startCompactionAttempt = (
    input: FsStartCompactionAttemptInput,
  ) => this.services.compactions.start(input);

  finishCompactionAttempt = (
    id: SessionId | string,
    attemptId: string | null,
    input: FsFinishCompactionAttemptInput,
  ) => this.services.compactions.finish(id, attemptId, input);

  getLatestCompactionAttempt = (id: SessionId | string) =>
    this.services.compactions.latest(id);

  listCompactionAttempts = (id: SessionId | string) =>
    this.services.compactions.list(id);

  getConversationChapterStatus = (id: SessionId | string) =>
    this.services.compactions.chapterStatus(id);

  recordProviderAttempt = (input: FsRecordProviderAttemptInput) =>
    this.services.providerAttempts.record(input);

  listProviderAttempts = (
    id: SessionId | string,
    limit?: number,
  ) => this.services.providerAttempts.list(id, limit);
}

export type FsHistoryMetricsApi = Pick<
  FsHistoryMetricsOperations,
  Exclude<keyof FsHistoryMetricsOperations, 'services'>
>;

export function installHistoryMetricsApi(
  target: object,
  directory: FsSessionDirectory,
  reader?: FsConversationReader,
): void {
  const operations = new FsHistoryMetricsOperations(
    new FsHistoryMetricsServices(directory, reader),
  );
  for (const name of Object.keys(operations)) {
    if (name === 'services') continue;
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: operations[name as keyof FsHistoryMetricsOperations],
    });
  }
}
