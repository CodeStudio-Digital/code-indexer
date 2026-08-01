import type { ConversationChapter, VisualGroup } from '../types.js';

export type ChapterTranscriptItem =
  | { kind: 'chapter'; chapter: ConversationChapter; key: string; seq: number }
  | { kind: 'message'; group: VisualGroup; key: string; seq: number };

export function sortChaptersChronologically(
  chapters: readonly ConversationChapter[],
): ConversationChapter[] {
  return [...chapters].sort((left, right) =>
    left.start_message_seq - right.start_message_seq
    || left.end_message_seq - right.end_message_seq
    || left.ordinal - right.ordinal
    || left.seq - right.seq);
}

export function visualGroupKey(group: VisualGroup): string {
  if (group.kind === 'user') {
    return `user:${group.usage?.id ?? group.messageId ?? 'unknown'}`;
  }
  const firstStableId = group.usages.find((usage) => usage?.id)?.id;
  const firstSeq = group.messageIds.find((seq) => seq != null);
  return `assistant:${firstStableId ?? firstSeq ?? 'unknown'}`;
}

export function visualGroupSeqs(group: VisualGroup): number[] {
  const values = group.kind === 'user'
    ? [group.usage?.seq ?? group.messageId]
    : group.usages.map((usage, index) => usage?.seq ?? group.messageIds[index]);
  return values.filter((value): value is number => (
    value != null && Number.isSafeInteger(value) && value > 0
  ));
}

function isCoveredByChapter(
  seqs: readonly number[],
  chapters: readonly ConversationChapter[],
): boolean {
  if (seqs.length === 0) return false;
  return chapters.some((chapter) => seqs.some((seq) => (
    seq >= chapter.start_message_seq && seq <= chapter.end_message_seq
  )));
}

/**
 * Build one canonical chronological timeline. Chapter cards exist even while
 * their source rows are not loaded, and any accidentally loaded source rows
 * are suppressed so expanding a chapter can never duplicate the transcript.
 */
export function buildChapterTranscript(
  chapters: readonly ConversationChapter[],
  groups: readonly VisualGroup[],
): ChapterTranscriptItem[] {
  const chronologicalChapters = sortChaptersChronologically(chapters);
  const items: ChapterTranscriptItem[] = chronologicalChapters.map((chapter) => ({
    kind: 'chapter',
    chapter,
    key: `chapter:${chapter.id}`,
    seq: chapter.start_message_seq,
  }));

  for (const group of groups) {
    const seqs = visualGroupSeqs(group);
    if (isCoveredByChapter(seqs, chronologicalChapters)) continue;
    items.push({
      kind: 'message',
      group,
      key: visualGroupKey(group),
      seq: seqs[0] ?? Number.POSITIVE_INFINITY,
    });
  }

  return items.sort((left, right) => (
    left.seq - right.seq
    || (left.kind === right.kind ? 0 : left.kind === 'chapter' ? -1 : 1)
  ));
}
