/**
 * Investigations tab — durable digests of sub-agent (spawn_agent)
 * explorations, auto-captured on completion, scoped to the open session.
 * Compact list; a click opens the full digest in a modal rendered as markdown.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Telescope } from 'lucide-react';
import { Markdown } from '../messages/Markdown.js';
import { DriveDetailDialog } from './DriveDetailDialog.js';
import type { DriveInvestigation } from './types.js';

export function DriveInvestigationsTab({ investigations }: { investigations: DriveInvestigation[] }) {
  const { t } = useTranslation('chat');
  const [selected, setSelected] = useState<DriveInvestigation | null>(null);

  if (investigations.length === 0) {
    return (
      <div className="text-xs text-muted-foreground text-center py-8 flex flex-col items-center gap-2">
        <Telescope className="h-5 w-5 opacity-50" />
        {t('drive.investigationsEmpty', 'No sub-agent investigations captured yet.')}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {investigations.map((inv) => (
        <button
          key={inv.id}
          type="button"
          onClick={() => setSelected(inv)}
          className="w-full text-left rounded border border-border/40 bg-muted/20 px-2 py-1.5 hover:bg-muted/40 transition-colors"
        >
          <div className="text-[11px] font-medium truncate">{inv.topic}</div>
          <div className="text-[10px] text-muted-foreground">
            {inv.agent_type ?? 'explore'} · {inv.created_at}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
            {inv.summary.replace(/\s+/g, ' ').trim()}
          </p>
        </button>
      ))}

      {selected ? (
        <DriveDetailDialog
          open
          onOpenChange={(o) => { if (!o) setSelected(null); }}
          title={selected.topic}
          meta={`${selected.agent_type ?? 'explore'} · ${selected.created_at}`}
        >
          <Markdown text={selected.body || selected.summary} />
        </DriveDetailDialog>
      ) : null}
    </div>
  );
}
