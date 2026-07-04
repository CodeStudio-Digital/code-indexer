/**
 * Left gutter of one timeline track row: activity highlight, name (double-
 * click renames inline), visibility eye and delete (hidden for the Base
 * track — it is the timing master of the shared grid).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { TrackMeta } from './api-anim.js';

export function TrackHeader({
  track,
  active,
  onActivate,
  onRename,
  onToggleVisible,
  onDelete,
}: {
  track: TrackMeta;
  active: boolean;
  onActivate: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onToggleVisible: (id: number, visible: boolean) => void;
  onDelete: (id: number) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.name);

  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== track.name) onRename(track.id, name);
    else setDraft(track.name);
  };

  return (
    <div
      className={cn(
        'flex w-32 shrink-0 items-center gap-1 rounded-l border-r px-1.5 py-1',
        active ? 'bg-primary/10' : 'hover:bg-muted/40',
      )}
      onClick={() => onActivate(track.id)}
    >
      <button
        type="button"
        title={track.visible ? t('animate.tracks.hide') : t('animate.tracks.show')}
        aria-label={track.visible ? t('animate.tracks.hide') : t('animate.tracks.show')}
        onClick={(e) => { e.stopPropagation(); onToggleVisible(track.id, !track.visible); }}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        {track.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3 opacity-60" />}
      </button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(track.name); setEditing(false); } }}
          onClick={(e) => e.stopPropagation()}
          className="h-5 w-full min-w-0 rounded border bg-background px-1 text-[10px] outline-none"
        />
      ) : (
        <span
          className={cn('min-w-0 flex-1 truncate text-[10px]', active ? 'font-medium text-foreground' : 'text-muted-foreground')}
          title={t('animate.tracks.renameHint')}
          onDoubleClick={() => { setDraft(track.name); setEditing(true); }}
        >
          {track.name}
        </span>
      )}
      {track.id !== 0 && (
        <button
          type="button"
          title={t('animate.tracks.delete')}
          aria-label={t('animate.tracks.delete')}
          onClick={(e) => { e.stopPropagation(); onDelete(track.id); }}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover/trackrow:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
