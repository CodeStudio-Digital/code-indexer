/**
 * Queue ("Fila") view of the Inbox — the interactive list, newest first,
 * with a client-side status filter and per-message respond/cancel actions.
 *
 * Pure w.r.t. data: the parent (`InboxPanel`) owns the fetch + store slice
 * and passes the full message set (DESC by id); this component owns only
 * the status filter and the row action calls. Extracted from InboxPanel
 * when the read-only Transcript view was merged in as a sibling toggle.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiPost } from '../../hooks/useApi.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import type { AgentInboxMessage, InboxStatus } from '@mcp/company-contracts';

const STATUS_VARIANTS: Record<InboxStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  delivered: 'default',
  answered: 'secondary',
  cancelled: 'destructive',
  expired: 'destructive',
};

interface InboxQueueProps {
  /** Full message set (DESC by id) from the parent. */
  messages: AgentInboxMessage[];
  companySessionId: number;
  initialized: boolean;
  onChanged: () => void;
}

export function InboxQueue({ messages, companySessionId, initialized, onChanged }: InboxQueueProps) {
  const { t } = useTranslation(['agents']);
  const [statusFilter, setStatusFilter] = useState<InboxStatus | 'all'>('all');

  const filtered = useMemo(
    () => (statusFilter === 'all' ? messages : messages.filter((m) => m.status === statusFilter)),
    [messages, statusFilter],
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-end border-b px-3 py-1.5">
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
      </div>

      <div className="flex-1 overflow-auto">
        {initialized && filtered.length === 0 && (
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
              onChanged={onChanged}
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
