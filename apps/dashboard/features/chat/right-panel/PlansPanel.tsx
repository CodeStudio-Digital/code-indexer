/**
 * Plans panel — dedicated right-rail tool window for `submit_plan` history.
 * Extracted from the old `details` panel's "Planos" tab so it gets its own
 * rail icon. Fetches `/coder/sessions/:id/plans` (gated on `active`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { copyText } from '../../../lib/clipboard.js';
import { cn, formatRelativeTime } from '../../../lib/utils.js';

interface CoderPlanRow {
  id: number;
  session_id: number;
  tool_use_id: string;
  message_id: number | null;
  plan_text: string;
  status: 'pending' | 'approved' | 'rejected' | 'aborted';
  feedback: string | null;
  created_at: string;
  resolved_at: string | null;
}

const STATUS_STYLES: Record<CoderPlanRow['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  approved: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  rejected: 'bg-red-500/15 text-red-600 dark:text-red-400',
  aborted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

export function PlansPanel({ sessionId, active }: { sessionId: number | null; active: boolean }) {
  const { t } = useTranslation(['chat', 'common']);
  const url = active && sessionId ? `/coder/sessions/${sessionId}/plans` : '';
  const { data: plans, loading } = useApi<CoderPlanRow[]>(url);
  return (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      {loading && <div className="text-xs text-muted-foreground">{t('common:actions.loading')}</div>}
      {!loading && (!plans || plans.length === 0) && (
        <div className="text-xs text-muted-foreground py-8 text-center">{t('chat:details.noPlans')}</div>
      )}
      <div className="space-y-2">{plans?.map((p) => <PlanItem key={p.id} plan={p} />)}</div>
    </div>
  );
}

function PlanItem({ plan }: { plan: CoderPlanRow }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (await copyText(plan.plan_text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const preview = plan.plan_text.split('\n').find((l) => l.trim()) ?? '';

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={cn('text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded', STATUS_STYLES[plan.status])}>
              {t(`details.planStatus.${plan.status}`)}
            </span>
            <span className="text-[11px] text-muted-foreground">{formatRelativeTime(plan.created_at)}</span>
            {plan.resolved_at && plan.resolved_at !== plan.created_at && (
              <span className="text-[11px] text-muted-foreground">
                · {t('details.resolvedAt', { time: formatRelativeTime(plan.resolved_at) })}
              </span>
            )}
          </div>
          {!open && <div className="text-xs text-foreground/80 truncate">{preview}</div>}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t bg-muted/20">
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 hover:bg-muted"
              aria-label={t('details.copyPlan')}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? t('details.copiedPlan') : t('details.copyPlan')}
            </button>
          </div>
          <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-card prose-pre:border prose-pre:rounded-lg prose-pre:p-3 prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.plan_text}</ReactMarkdown>
          </div>
          {plan.feedback && (
            <div className="mt-2 text-xs border-l-2 border-amber-500/50 pl-2 text-muted-foreground">
              <span className="font-semibold">{t('details.feedback')}</span> {plan.feedback}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
