import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardList, Copy, Pencil, X } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { copyText } from '../../../lib/clipboard.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from '../messages/Markdown.js';

interface PlanPromptViewProps {
  plan: { id: string; plan: string; resolved?: 'approved' | 'rejected'; kind?: 'informational' | 'mutating' };
  /**
   * Three verdicts: Accept (`approved`), Revise (`approved:false` — keep
   * planning with feedback), Reject (`aborted:true` — end the planning run).
   */
  onResponse: (verdict: { approved: boolean; aborted?: boolean; feedback?: string }) => Promise<void>;
}

export function PlanPromptView({ plan, onResponse }: PlanPromptViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [feedback, setFeedback] = useState('');
  const [resolved, setResolved] = useState<string | undefined>(plan.resolved);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (await copyText(plan.plan)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="my-3 rounded-xl border border-warning/40 bg-warning/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-warning/15 text-warning flex items-center justify-center">
          <ClipboardList className="h-4 w-4" />
        </div>
        <div className="text-xs font-semibold text-warning uppercase tracking-wider flex-1 flex items-center gap-2">
          <span>{t('chat:plan.awaitingApproval')}</span>
          {plan.kind === 'informational' && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">
              {t('chat:plan.kindInformational')}
            </span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={handleCopy} className="h-7 px-2 text-[11px]">
          {copied ? (
            <>
              <Check className="h-3 w-3" /> {t('chat:plan.copied')}
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> {t('chat:plan.copyMd')}
            </>
          )}
        </Button>
      </div>
      <div className="text-sm text-foreground mb-3 px-1">
        <Markdown text={plan.plan} />
      </div>
      {!resolved ? (
        <>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t('chat:plan.feedbackPlaceholder')}
            rows={2}
            className="mb-2 text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="success"
              onClick={async () => {
                await onResponse({ approved: true, feedback });
                setResolved('approved');
              }}
            >
              <Check className="h-3.5 w-3.5" /> {t('common:actions.approve')}
            </Button>
            {/* Revise — keep planning with feedback (agent re-submits). */}
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await onResponse({ approved: false, feedback });
                setResolved('revise');
              }}
            >
              <Pencil className="h-3.5 w-3.5" /> {t('chat:plan.revise')}
            </Button>
            {/* Reject — end the planning run (aborted). */}
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                await onResponse({ approved: false, aborted: true, feedback });
                setResolved('reject');
              }}
            >
              <X className="h-3.5 w-3.5" /> {t('chat:plan.reject')}
            </Button>
          </div>
        </>
      ) : (
        <div
          className={cn(
            'text-xs flex items-center gap-1.5',
            resolved === 'approved'
              ? 'text-success'
              : resolved === 'revise'
                ? 'text-warning'
                : 'text-destructive',
          )}
        >
          {resolved === 'approved' ? (
            <Check className="h-3.5 w-3.5" />
          ) : resolved === 'revise' ? (
            <Pencil className="h-3.5 w-3.5" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
          {resolved === 'approved'
            ? t('chat:plan.approved')
            : resolved === 'revise'
              ? t('chat:plan.reviseRequested')
              : t('chat:plan.rejected')}
        </div>
      )}
    </div>
  );
}
