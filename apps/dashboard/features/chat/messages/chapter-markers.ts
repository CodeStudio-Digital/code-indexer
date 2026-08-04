import type { ConversationChapter, VisualGroup } from '../types.js';
import { sortChaptersChronologically } from './chapter-transcript.js';

interface ChapterTrackedRow {
  kind: string;
  chapter?: Pick<ConversationChapter, 'id'>;
}

interface PositionedTranscriptRow {
  index: number;
  end: number;
}

/**
 * Resolve the chapter at the viewport's leading edge while ignoring rows that
 * are mounted only as virtualizer overscan.
 */
export function activeChapterIdAtScrollOffset(
  rows: readonly ChapterTrackedRow[],
  mountedRows: readonly PositionedTranscriptRow[],
  scrollOffset: number,
): string | null {
  const firstVisible = mountedRows.find((item) => item.end > scrollOffset)
    ?? mountedRows.at(-1);
  if (!firstVisible) return null;

  for (let index = Math.min(firstVisible.index, rows.length - 1); index >= 0; index--) {
    const row = rows[index];
    if (row?.kind === 'chapter' && row.chapter) return row.chapter.id;
  }
  return null;
}

function groupMessageIds(group: VisualGroup): number[] {
  if (group.kind === 'user') return group.messageId == null ? [] : [group.messageId];
  return group.messageIds.filter((id): id is number => id != null);
}

/** Put a divider before the first loaded group that belongs to each chapter. */
export function loadedChapterMarkers(
  chapters: ConversationChapter[],
  groups: VisualGroup[],
): Map<number, ConversationChapter[]> {
  const markers = new Map<number, ConversationChapter[]>();
  for (const chapter of sortChaptersChronologically(chapters)) {
    const groupIndex = groups.findIndex((group) => groupMessageIds(group).some(
      (id) => id >= chapter.start_message_seq && id <= chapter.end_message_seq,
    ));
    if (groupIndex < 0) continue;
    const current = markers.get(groupIndex) ?? [];
    current.push(chapter);
    markers.set(groupIndex, current);
  }
  return markers;
}
