/**
 * Inbox — the single operator surface for the inter-agent message queue.
 *
 * Merges what used to be two overlapping surfaces (the right-rail Inbox
 * and the Work-zone Transcript tab) into one panel with a view toggle,
 * both backed by the same fetch + `inboxSlice`:
 *   - "Fila" (queue)     → interactive, status-filtered, respond/cancel.
 *   - "Atividade" (thread) → read-only threaded transcript, ASC by time.
 *
 * Live-update: every `inbox_message_*` SSE event bumps the slice's
 * `lastEventSeq` and we refetch; a 5 s poll is the fallback while the
 * stream is disconnected (orchestrator dormant / tab opened cold).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox, MessageCircle, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  selectInbox,
  selectStream,
  useCompanyStore,
} from '../../state/company/index.js';
import { InboxQueue } from './InboxQueue.js';
import { TranscriptThread } from './transcript/TranscriptThread.js';
import type { AgentInboxMessage } from '@mcp/company-contracts';

type InboxView = 'queue' | 'activity';

interface InboxPanelProps {
  companySessionId: number;
}

export function InboxPanel({ companySessionId }: InboxPanelProps) {
  const { t } = useTranslation(['agents']);
  const [view, setView] = useState<InboxView>('queue');

  const slot = useCompanyStore((s) => selectInbox(s, companySessionId));
  const inboxHydrate = useCompanyStore((s) => s.inboxHydrate);
  const inboxSetLoading = useCompanyStore((s) => s.inboxSetLoading);
  const inboxSetError = useCompanyStore((s) => s.inboxSetError);
  const connected = useCompanyStore((s) => selectStream(s, companySessionId).connected);

  // Fetch the FULL list (no status query param) — both views read the same
  // slice; the queue filters by status client-side.
  const refresh = useCallback(async () => {
    inboxSetLoading(companySessionId, true);
    inboxSetError(companySessionId, null);
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/inbox`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as AgentInboxMessage[];
      inboxHydrate(companySessionId, body);
    } catch (e) {
      inboxSetError(companySessionId, e instanceof Error ? e.message : String(e));
    } finally {
      inboxSetLoading(companySessionId, false);
    }
  }, [companySessionId, inboxHydrate, inboxSetLoading, inboxSetError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE-driven refetch — reload whenever an `inbox_message_*` event ticks
  // the counter. Intentionally omit `refresh` so it fires only on the tick.
  useEffect(() => {
    if (slot.lastEventSeq === 0) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.lastEventSeq]);

  // Poll fallback — only while disconnected.
  useEffect(() => {
    if (connected) return;
    const handle = setInterval(() => void refresh(), 5000);
    return () => clearInterval(handle);
  }, [connected, refresh]);

  const all = useMemo(() => Array.from(slot.messagesById.values()), [slot.messagesById]);
  const queueMessages = useMemo(() => [...all].sort((a, b) => b.id - a.id), [all]);
  // ASC by created_at (id tiebreak); newest at the bottom, capped at 200.
  const activityMessages = useMemo(() => {
    const list = [...all].sort((a, b) => {
      const ta = Date.parse(a.created_at) || 0;
      const tb = Date.parse(b.created_at) || 0;
      return ta !== tb ? ta - tb : a.id - b.id;
    });
    return list.slice(-200);
  }, [all]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Inbox className="h-4 w-4" />
          <span className="text-xs">
            {all.length} {t('agents:inbox.messages')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border p-0.5 text-[11px]">
            <ViewTab
              active={view === 'queue'}
              onClick={() => setView('queue')}
              icon={Inbox}
              label={t('agents:inbox.viewQueue', { defaultValue: 'Fila' })}
            />
            <ViewTab
              active={view === 'activity'}
              onClick={() => setView('activity')}
              icon={MessageCircle}
              label={t('agents:inbox.viewActivity', { defaultValue: 'Atividade' })}
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {view === 'queue' ? (
        <InboxQueue
          messages={queueMessages}
          companySessionId={companySessionId}
          initialized={slot.initialized}
          onChanged={() => void refresh()}
        />
      ) : (
        <TranscriptThread messages={activityMessages} initialized={slot.initialized} />
      )}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Inbox;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="h-3 w-3" /> {label}
    </button>
  );
}
