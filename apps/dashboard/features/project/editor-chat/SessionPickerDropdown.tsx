/**
 * Compact sessions list shown in the rail before a session is open. Picks
 * an existing session or creates a new one. Sessions are shared with the
 * full Chat tab (same project_id), so anything started here shows up there.
 */
import { useTranslation } from 'react-i18next';
import { Inbox, MessageSquare } from 'lucide-react';
import type { CoderSession } from '../../chat/types.js';

interface Props {
  projectName: string;
  sessions: CoderSession[] | null;
  onPick: (id: number) => void;
}

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

export function SessionPickerDropdown({ projectName, sessions, onPick }: Props) {
  const { t } = useTranslation('workspace');
  const list = sessions ?? [];

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        {list.length === 0 ? (
          <div className="px-3 py-6 grid place-items-center text-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-primary/10 grid place-items-center">
              <Inbox className="h-4 w-4 text-primary/70" />
            </div>
            <div>
              <p className="text-[12px] font-medium text-foreground">{t('chat.empty.activeTitle')}</p>
              <p className="text-[10.5px] text-muted-foreground mt-0.5">
                {t('chat.empty.activeDescription', { projectName })}
              </p>
            </div>
          </div>
        ) : (
          list.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s.id)}
              className="group w-full text-left px-2.5 py-1.5 border-b last:border-b-0 hover:bg-muted/40 transition-colors flex flex-col gap-0.5"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                <span className="text-[11.5px] font-medium truncate flex-1">{s.title}</span>
                {s.is_favorite && <span className="text-amber-400 text-[10px]">★</span>}
              </div>
              <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                <span className="font-mono truncate">{s.model || s.provider}</span>
                <span className="opacity-40">·</span>
                <span title={s.updated_at}>{relativeTime(s.updated_at)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
