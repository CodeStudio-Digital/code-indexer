import React from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import {
  getPendingAttachments,
  removePendingAttachment,
  subscribePendingAttachments,
} from '../studio-context-store.js';
import type { AgentAttachment } from '../../../../hooks/useAgentStream.js';

/**
 * Thumbnails for region-select screenshots staged for the next message. Each
 * rides as an image attachment (drained by `consumePendingAttachments` at send
 * time); the ✕ drops it before sending. Sibling of `SelectionChip` — that cites
 * the elements inside the box, this shows the captured box image.
 */
export function RegionShotChip({ projectId }: { projectId: number }) {
  const shots = usePendingAttachments(projectId);
  if (!shots.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {shots.map((att, i) => (
        <div
          key={`${att.name}-${i}`}
          className="flex items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40 px-1.5 py-1 text-xs"
        >
          {att.base64 ? (
            <img
              src={`data:${att.mediaType};base64,${att.base64}`}
              alt={att.name}
              className="h-8 w-12 rounded-sm border border-indigo-200 object-cover dark:border-indigo-800"
            />
          ) : (
            <ImageIcon className="h-3.5 w-3.5 text-indigo-500" />
          )}
          <span className="max-w-[120px] truncate text-indigo-700 dark:text-indigo-300" title={att.name}>
            {att.name}
          </span>
          <button
            type="button"
            onClick={() => removePendingAttachment(projectId, i)}
            className="ml-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Remove screenshot"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Subscribe to the module store for this project's staged screenshots. */
function usePendingAttachments(projectId: number): AgentAttachment[] {
  const [atts, setAtts] = React.useState<AgentAttachment[]>(() => getPendingAttachments(projectId));
  React.useEffect(() => {
    setAtts(getPendingAttachments(projectId));
    return subscribePendingAttachments(projectId, () => setAtts(getPendingAttachments(projectId)));
  }, [projectId]);
  return atts;
}
