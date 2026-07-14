/**
 * Derives, from the visual message groups, the set of files each completed
 * assistant turn edited — so a "files changed" summary can be injected after the
 * turn's last assistant group. Pure + drift-free: recomputed from the persisted
 * tool calls, so it survives reloads and appears on scrollback.
 *
 * A "turn" is a maximal run of consecutive assistant groups (groupMessages
 * already splits on user messages). The result is keyed by the run's LAST
 * assistant-group index.
 */
import type { VisualGroup } from '../types.js';
import { filesFromEditToolCall, type EditFileRef } from './edit-tools.js';

export interface TurnEditSummary {
  roundMessageId?: number;
  paths: EditFileRef[];
}

export function computeTurnEditSummaries(groups: VisualGroup[]): Map<number, TurnEditSummary> {
  const out = new Map<number, TurnEditSummary>();
  let byPath = new Map<string, EditFileRef>();
  let roundMessageId: number | undefined;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (g.kind === 'user') {
      roundMessageId = g.messageId;
      continue;
    }

    for (const msg of g.messages) {
      for (const b of msg.content) {
        if (b.type !== 'tool_use') continue;
        for (const ref of filesFromEditToolCall(b.name, b.input)) {
          byPath.set(ref.path, ref); // last op for a path wins within the turn
        }
      }
    }

    // Flush at the end of this assistant run (next group is a user turn, or EOF).
    const next = groups[gi + 1];
    if (!next || next.kind === 'user') {
      if (byPath.size > 0) {
        out.set(gi, { roundMessageId, paths: [...byPath.values()] });
      }
      byPath = new Map();
    }
  }
  return out;
}
