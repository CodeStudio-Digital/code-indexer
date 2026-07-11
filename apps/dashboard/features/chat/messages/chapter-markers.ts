import type { ConversationChapter, VisualGroup } from '../types.js';

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
  for (const chapter of chapters) {
    const groupIndex = groups.findIndex((group) => groupMessageIds(group).some(
      (id) => id >= chapter.start_message_id && id <= chapter.end_message_id,
    ));
    if (groupIndex < 0) continue;
    const current = markers.get(groupIndex) ?? [];
    current.push(chapter);
    markers.set(groupIndex, current);
  }
  return markers;
}
