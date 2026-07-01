/**
 * Threaded, read-only rendering of inter-agent messages — the "Atividade"
 * view of the Inbox. Pure: the parent (`InboxPanel`) owns fetching and the
 * store subscription and passes an ASC-sorted `messages` slice.
 *
 * Groups by `wait_token` (a synthetic `solo-<id>` key for unthreaded rows),
 * newest at the bottom so it reads like a chat, and flags the master
 * observer copies (`[INBOX-OBSERVED]`). Extracted verbatim from the former
 * standalone Transcript tab when it was merged into the Inbox panel.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, MessageCircle } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import type { AgentInboxMessage, InboxStatus } from '@mcp/company-contracts';

const STATUS_VARIANTS: Record<InboxStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  delivered: 'default',
  answered: 'secondary',
  cancelled: 'destructive',
  expired: 'destructive',
};

interface TranscriptThreadProps {
  /** ASC-by-created_at slice (parent caps at the most recent 200). */
  messages: AgentInboxMessage[];
  /** Distinguishes "loading" from "genuinely empty" for the empty state. */
  initialized: boolean;
}

export function TranscriptThread({ messages, initialized }: TranscriptThreadProps) {
  const { t } = useTranslation(['agents']);
  const groups = useMemo(() => groupByThread(messages), [messages]);

  return (
    <div className="flex-1 overflow-auto p-3 space-y-3">
      {initialized && messages.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-3 py-12 text-center">
          <MessageCircle className="h-10 w-10 text-muted-foreground/30" strokeWidth={1.25} />
          <p className="max-w-xs text-xs text-muted-foreground">
            {t('agents:transcript.empty')}
          </p>
        </div>
      )}
      {groups.map((group) => (
        <TranscriptGroup key={group.key} group={group} />
      ))}
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
    <div
      className={
        isThread
          ? 'rounded-md border border-border/60 bg-muted/30 p-2 space-y-1.5 transition-colors hover:border-border'
          : 'rounded-md px-2 py-1 space-y-1 transition-colors hover:bg-muted/30'
      }
    >
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
    <div className={`text-[11px] ${isFollowUp ? 'pl-3 border-l-2 border-border/60' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-foreground">@{message.from_role}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
        <span className="font-semibold">{target}</span>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal">
          {message.kind}
        </Badge>
        <Badge
          variant={STATUS_VARIANTS[message.status]}
          className="text-[9px] px-1.5 py-0 font-normal"
        >
          {message.status}
        </Badge>
        {isBroadcastCopy && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 font-normal border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          >
            {t('agents:transcript.observed')}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">
          {message.created_at}
        </span>
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground">
        {message.body}
      </pre>
      {message.answer && (
        <pre className="mt-1.5 ml-3 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-emerald-700 dark:text-emerald-400">
          ↳ {message.answer}
        </pre>
      )}
    </div>
  );
}
