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

export function computeTurnEditSummaries(groups: VisualGroup[]): Map<number, EditFileRef[]> {
  const out = new Map<number, EditFileRef[]>();
  let byPath = new Map<string, EditFileRef>();

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (g.kind !== 'assistant') continue;

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
      if (byPath.size > 0) out.set(gi, [...byPath.values()]);
      byPath = new Map();
    }
  }
  return out;
}
