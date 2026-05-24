/**
 * Inbox panel — operator-facing view of the inter-agent message queue.
 *
 * Lists every `agent_inbox` row for the session, grouped by status, and
 * lets the operator:
 *   - Cancel a stuck message (sender unblocks with a cancellation note)
 *   - Answer on behalf of the target (when an agent dies without
 *     responding to a `wait=true` send)
 *
 * Phase 2: messages live in the `inboxSlice`. Each `inbox_message_*`
 * SSE event bumps a sequence counter the panel watches with `useEffect`
 * — when it changes, the panel refetches and hydrates the slice. The
 * 5 s poll stays only as a fallback for when the SSE stream is
 * disconnected (the orchestrator is dormant or the user just opened
 * the tab without starting/reattaching).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox, RefreshCw, Send, Square } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiPost } from '../../hooks/useApi.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import {
  selectInbox,
  selectStream,
  useCompanyStore,
} from '../../state/company/index.js';
import type { AgentInboxMessage, InboxStatus } from '@mcp/company-contracts';

interface InboxPanelProps {
  companySessionId: number;
}

const STATUS_VARIANTS: Record<InboxStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  delivered: 'default',
  answered: 'secondary',
  cancelled: 'destructive',
  expired: 'destructive',
};

export function InboxPanel({ companySessionId }: InboxPanelProps) {
  const { t } = useTranslation(['agents', 'common']);

  const [statusFilter, setStatusFilter] = useState<InboxStatus | 'all'>('all');
  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    const q = params.toString();
    return `/api/company/sessions/${companySessionId}/inbox${q ? `?${q}` : ''}`;
  }, [companySessionId, statusFilter]);

  const slot = useCompanyStore((s) => selectInbox(s, companySessionId));
  const inboxHydrate = useCompanyStore((s) => s.inboxHydrate);
  const inboxSetLoading = useCompanyStore((s) => s.inboxSetLoading);
  const inboxSetError = useCompanyStore((s) => s.inboxSetError);
  const connected = useCompanyStore((s) => selectStream(s, companySessionId).connected);

  const refresh = useCallback(async () => {
    inboxSetLoading(companySessionId, true);
    inboxSetError(companySessionId, null);
    try {
      const res = await fetch(queryUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as AgentInboxMessage[];
      inboxHydrate(companySessionId, body);
    } catch (e) {
      inboxSetError(companySessionId, e instanceof Error ? e.message : String(e));
    } finally {
      inboxSetLoading(companySessionId, false);
    }
  }, [companySessionId, queryUrl, inboxHydrate, inboxSetLoading, inboxSetError]);

  // Initial load + reload when the status filter changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE-driven refetch — any `inbox_message_*` event bumps the slice's
  // `lastEventSeq` and we reload the list. Cheaper than polling every
  // 5 s and tighter than waiting for the user to hit refresh.
  useEffect(() => {
    if (slot.lastEventSeq === 0) return;
    void refresh();
    // refresh is stable per (companySessionId, queryUrl); intentionally
    // omit it so the effect runs ONLY when the counter ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.lastEventSeq]);

  // Poll fallback — only while disconnected, same pattern as DrivePanel.
  useEffect(() => {
    if (connected) return;
    const handle = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(handle);
  }, [connected, refresh]);

  const messages = useMemo(
    () => Array.from(slot.messagesById.values()).sort((a, b) => b.id - a.id),
    [slot.messagesById],
  );

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return messages;
    return messages.filter((m) => m.status === statusFilter);
  }, [messages, statusFilter]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Inbox className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {filtered.length} {t('agents:inbox.messages')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as InboxStatus | 'all')}
            className="h-7 rounded border bg-background px-2 text-xs"
          >
            <option value="all">{t('agents:inbox.filterAll')}</option>
            <option value="pending">pending</option>
            <option value="delivered">delivered</option>
            <option value="answered">answered</option>
            <option value="cancelled">cancelled</option>
            <option value="expired">expired</option>
          </select>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {slot.initialized && filtered.length === 0 && (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            {t('agents:inbox.empty')}
          </div>
        )}
        <ul className="divide-y">
          {filtered.map((m) => (
            <InboxRow
              key={m.id}
              message={m}
              companySessionId={companySessionId}
              onChanged={() => void refresh()}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function InboxRow({
  message,
  companySessionId,
  onChanged,
}: {
  message: AgentInboxMessage;
  companySessionId: number;
  onChanged: () => void;
}) {
  const { t } = useTranslation(['agents', 'common']);
  const [showRespond, setShowRespond] = useState(false);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  const handleCancel = async () => {
    const ok = await confirm({
      title: t('agents:inbox.confirmCancel'),
      confirmLabel: t('agents:inbox.cancelAction', { defaultValue: 'Cancel message' }),
      tone: 'destructive',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiPost(`/company/sessions/${companySessionId}/inbox/${message.id}/cancel`, {
        reason: 'cancelled by operator',
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleRespond = async () => {
    setBusy(true);
    try {
      await apiPost(`/company/sessions/${companySessionId}/inbox/${message.id}/respond`, {
        answer,
      });
      setAnswer('');
      setShowRespond(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const target =
    message.to_role
      ? `@${message.to_role}`
      : message.to_agent_run_id
        ? `run=${message.to_agent_run_id}`
        : '?';

  const isOpen = message.status === 'pending' || message.status === 'delivered';

  return (
    <li className="px-3 py-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">@{message.from_role}</span>
            <Send className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium">{target}</span>
            <Badge variant="outline" className="text-[10px]">{message.kind}</Badge>
            <Badge variant={STATUS_VARIANTS[message.status]} className="text-[10px]">
              {message.status}
            </Badge>
          </div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">
            {message.body}
          </pre>
          {message.answer && (
            <div className="mt-2 rounded bg-muted p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('agents:inbox.answer')}
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[11px]">{message.answer}</pre>
            </div>
          )}
          <div className="mt-1 text-[10px] text-muted-foreground">
            {message.created_at}
            {message.delivered_at && ` · delivered ${message.delivered_at}`}
            {message.answered_at && ` · answered ${message.answered_at}`}
          </div>
        </div>
        {isOpen && (
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setShowRespond((v) => !v)}>
              {t('agents:inbox.respondAsHuman')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={handleCancel}>
              <Square className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {showRespond && (
        <div className="mt-2 rounded border bg-muted/50 p-2">
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            placeholder={t('agents:inbox.answerPlaceholder')}
            className="text-xs"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowRespond(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button size="sm" disabled={busy || !answer.trim()} onClick={handleRespond}>
              {t('agents:inbox.send')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
