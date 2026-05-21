/**
 * Inbox transcript — chronological, read-only feed of inter-agent
 * messages for one company session.
 *
 * Different from {@link InboxPanel}:
 *   - Transcript is ASC by `created_at`, threaded by `wait_token`.
 *   - Read-only — no cancel/respond affordances (the operator uses
 *     InboxPanel for that).
 *   - Includes master observer messages (the `[INBOX-OBSERVED]` notify
 *     copies that Phase B emits when `master_broadcast_subscribe` is on).
 *
 * Live-update strategy mirrors the InboxPanel: subscribe to the
 * `inboxSlice` via Zustand, refetch on every `lastEventSeq` tick. We
 * deliberately reuse the same store rows so the two panels stay
 * consistent without a second cache.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, MessageCircle, RefreshCw } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import {
  selectInbox,
  selectStream,
  useCompanyStore,
} from '../../../state/company/index.js';
import type { AgentInboxMessage, InboxStatus } from '@mcp/company-contracts';

interface InboxTranscriptPanelProps {
  sessionId: number;
}

const STATUS_VARIANTS: Record<InboxStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  delivered: 'default',
  answered: 'secondary',
  cancelled: 'destructive',
  expired: 'destructive',
};

export function InboxTranscriptPanel({ sessionId }: InboxTranscriptPanelProps) {
  const { t } = useTranslation(['agents']);
  const slot = useCompanyStore((s) => selectInbox(s, sessionId));
  const inboxHydrate = useCompanyStore((s) => s.inboxHydrate);
  const inboxSetLoading = useCompanyStore((s) => s.inboxSetLoading);
  const inboxSetError = useCompanyStore((s) => s.inboxSetError);
  const connected = useCompanyStore((s) => selectStream(s, sessionId).connected);

  const refresh = useCallback(async () => {
    inboxSetLoading(sessionId, true);
    inboxSetError(sessionId, null);
    try {
      const res = await fetch(`/api/company/sessions/${sessionId}/inbox`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as AgentInboxMessage[];
      inboxHydrate(sessionId, body);
    } catch (e) {
      inboxSetError(sessionId, e instanceof Error ? e.message : String(e));
    } finally {
      inboxSetLoading(sessionId, false);
    }
  }, [sessionId, inboxHydrate, inboxSetLoading, inboxSetError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE-driven refresh — same handshake as InboxPanel.
  useEffect(() => {
    if (slot.lastEventSeq === 0) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.lastEventSeq]);

  // Poll fallback while disconnected.
  useEffect(() => {
    if (connected) return;
    const handle = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(handle);
  }, [connected, refresh]);

  // Chronological ascending — newest at the bottom so the feed reads
  // like a chat. Cap at the most recent 200 to keep the DOM cheap.
  const messages = useMemo(() => {
    const list = Array.from(slot.messagesById.values()).sort((a, b) => {
      const ta = Date.parse(a.created_at) || 0;
      const tb = Date.parse(b.created_at) || 0;
      if (ta !== tb) return ta - tb;
      return a.id - b.id;
    });
    return list.slice(-200);
  }, [slot.messagesById]);

  const groups = useMemo(() => groupByThread(messages), [messages]);

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <MessageCircle className="h-4 w-4" />
          <span>{t('agents:transcript.summary', { count: messages.length })}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {slot.initialized && messages.length === 0 && (
          <div className="text-center text-xs text-muted-foreground py-12">
            {t('agents:transcript.empty')}
          </div>
        )}
        {groups.map((group) => (
          <TranscriptGroup key={group.key} group={group} />
        ))}
      </div>
    </div>
  );
}

interface TranscriptGroupShape {
  /** Either the wait_token or a synthetic key (`solo-<id>`) for unthreaded rows. */
  key: string;
  messages: AgentInboxMessage[];
}

function groupByThread(messages: readonly AgentInboxMessage[]): TranscriptGroupShape[] {
  const buckets = new Map<string, AgentInboxMessage[]>();
  for (const m of messages) {
    const key = m.wait_token ?? `solo-${m.id}`;
    const existing = buckets.get(key);
    if (existing) existing.push(m);
    else buckets.set(key, [m]);
  }
  return Array.from(buckets.entries()).map(([key, msgs]) => ({ key, messages: msgs }));
}

function TranscriptGroup({ group }: { group: TranscriptGroupShape }) {
  const head = group.messages[0];
  if (!head) return null;
  const isThread = group.messages.length > 1;
  return (
    <div className={isThread ? 'rounded border border-border/40 bg-muted/20 p-2 space-y-1' : 'space-y-1'}>
      {group.messages.map((m) => (
        <TranscriptRow key={m.id} message={m} isFollowUp={m !== head && isThread} />
      ))}
    </div>
  );
}

function TranscriptRow({
  message,
  isFollowUp,
}: {
  message: AgentInboxMessage;
  isFollowUp: boolean;
}) {
  const { t } = useTranslation(['agents']);
  const target = message.to_role === '__master__'
    ? '@master'
    : message.to_role
      ? `@${message.to_role}`
      : message.to_agent_run_id
        ? `run=${message.to_agent_run_id}`
        : '@?';
  const isBroadcastCopy = message.kind === 'notify' && message.to_role === '__master__' && message.body.startsWith('[INBOX-OBSERVED');

  return (
    <div className={`text-[11px] ${isFollowUp ? 'pl-3 border-l-2 border-border/50' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground">@{message.from_role}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">{target}</span>
        <Badge variant="outline" className="text-[9px] px-1 py-0">{message.kind}</Badge>
        <Badge variant={STATUS_VARIANTS[message.status]} className="text-[9px] px-1 py-0">
          {message.status}
        </Badge>
        {isBroadcastCopy && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 border-amber-500/50 text-amber-600">
            {t('agents:transcript.observed')}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">{message.created_at}</span>
      </div>
      <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[10.5px] text-muted-foreground">
        {message.body}
      </pre>
      {message.answer && (
        <pre className="mt-1 ml-3 whitespace-pre-wrap break-words font-mono text-[10.5px] text-emerald-700 dark:text-emerald-400">
          ↳ {message.answer}
        </pre>
      )}
    </div>
  );
}
