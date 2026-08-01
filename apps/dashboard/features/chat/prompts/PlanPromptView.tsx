import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, CircleAlert, Check, ClipboardList, Copy, Pencil, X } from 'lucide-react';
import type { PlanResolution } from '../../../hooks/useAgentStream.js';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { copyText } from '../../../lib/clipboard.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from '../messages/Markdown.js';

interface PlanPromptViewProps {
  plan: { id: string; plan: string; resolved?: PlanResolution; kind?: 'informational' | 'mutating' };
  /**
   * Three verdicts: Accept (`approved`), Revise (`approved:false` — keep
   * planning with feedback), Reject (`aborted:true` — end the planning run).
   */
  onResponse: (verdict: { approved: boolean; aborted?: boolean; feedback?: string }) => Promise<void>;
}

export function PlanPromptView({ plan, onResponse }: PlanPromptViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [feedback, setFeedback] = useState('');
  const [resolved, setResolved] = useState<PlanResolution | undefined>(plan.resolved);
  const [expanded, setExpanded] = useState(() => !plan.resolved);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (await copyText(plan.plan)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  const respond = async (
    resolution: Exclude<PlanResolution, 'validation_error'>,
    verdict: { approved: boolean; aborted?: boolean; feedback?: string },
  ) => {
    // The restart-resume path keeps this promise open while the new agent run
    // streams. Reflect the accepted click immediately; otherwise the old card
    // keeps looking pending (and remains clickable) until that run finishes.
    setResolved(resolution);
    try {
      await onResponse(verdict);
      setExpanded(false);
    } catch (error) {
      // A transport failure means the verdict was not acknowledged. Restore
      // the controls so the user can retry instead of showing a false outcome.
      setResolved(undefined);
      throw error;
    }
  };
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border/70 bg-card/45">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90')} />
          <ClipboardList className="h-4 w-4 shrink-0 text-warning" />
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-foreground/85">
            <span>
              {resolved === 'validation_error'
                ? t('chat:plan.validationFailedTitle')
                : resolved
                  ? t('chat:plan.title')
                  : t('chat:plan.awaitingApproval')}
            </span>
            {plan.kind === 'informational' && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">
                {t('chat:plan.kindInformational')}
              </span>
            )}
            {resolved && (
              <span className={cn(
                'ml-auto text-[11px]',
                resolved === 'approved'
                  ? 'text-success'
                  : resolved === 'revision_requested'
                    ? 'text-warning'
                    : 'text-destructive',
              )}>
                {resolved === 'approved'
                  ? t('chat:plan.approved')
                  : resolved === 'revision_requested'
                    ? t('chat:plan.reviseRequested')
                    : resolved === 'validation_error'
                      ? t('chat:plan.validationError')
                      : t('chat:plan.rejected')}
              </span>
            )}
          </div>
        </button>
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
      {expanded && (
        <div className="border-t border-border/60 px-3 py-3">
          <div className="mb-3 text-sm text-foreground">
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
                    await respond('approved', { approved: true, feedback });
                  }}
                >
                  <Check className="h-3.5 w-3.5" /> {t('common:actions.approve')}
                </Button>
                {/* Revise — keep planning with feedback (agent re-submits). */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await respond('revision_requested', { approved: false, feedback });
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" /> {t('chat:plan.revise')}
                </Button>
                {/* Reject — end the planning run (aborted). */}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={async () => {
                    await respond('rejected', { approved: false, aborted: true, feedback });
                  }}
                >
                  <X className="h-3.5 w-3.5" /> {t('chat:plan.reject')}
                </Button>
              </div>
            </>
          ) : (
            <div
              className={cn(
                'flex items-center gap-1.5 text-xs',
                resolved === 'approved'
                  ? 'text-success'
                  : resolved === 'revision_requested'
                    ? 'text-warning'
                    : 'text-destructive',
              )}
            >
              {resolved === 'approved' ? (
                <Check className="h-3.5 w-3.5" />
              ) : resolved === 'revision_requested' ? (
                <Pencil className="h-3.5 w-3.5" />
              ) : resolved === 'validation_error' ? (
                <CircleAlert className="h-3.5 w-3.5" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
              {resolved === 'approved'
                ? t('chat:plan.approved')
                : resolved === 'revision_requested'
                  ? t('chat:plan.reviseRequested')
                  : resolved === 'validation_error'
                    ? t('chat:plan.validationError')
                    : t('chat:plan.rejected')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
