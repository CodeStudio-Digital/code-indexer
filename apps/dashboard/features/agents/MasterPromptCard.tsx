import React, { memo, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, HelpCircle, CheckCircle, XCircle, Send, Ban, Loader2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { formatClock } from '../../lib/datetime.js';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import type { MasterPrompt } from '@mcp/company/types.js';

/**
 * Unified card for master↔human prompts rendered inline in the board
 * feed. Three visual states:
 *   - pending   → interactive (answer / approve+reject + freeform feedback)
 *   - answered  → read-only summary of what the human chose
 *   - cancelled → neutral note ("session ended before you answered")
 *
 * The prompt comes from the persisted DB row, so the card looks the same
 * whether it was just emitted via SSE or rehydrated on reload.
 */
export const MasterPromptCard = memo(function MasterPromptCard({
  prompt,
  onAnswerQuestion,
  onRespondPlan,
}: {
  prompt: MasterPrompt;
  onAnswerQuestion: (answer: string) => void;
  onRespondPlan: (approved: boolean, feedback?: string) => void;
}) {
  const { t } = useTranslation(['agents', 'common']);
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState('');
  // Defensive submit guard: one click was registering 3× (no in-flight lock),
  // spawning duplicate "Human answered" board entries. Lock on first submit,
  // show a processing state, and ignore further clicks until it settles.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);
  const submit = (fn: () => void): void => {
    if (submittingRef.current) return; // already in flight — swallow the extra clicks
    submittingRef.current = true;
    setSubmitting(true);
    try {
      fn();
    } finally {
      // On success the prompt flips to 'answered' and this whole interactive
      // block unmounts. This safety reset only matters if the answer FAILED
      // (card stays pending) so the user can retry after a few seconds. The
      // backend is also idempotent, so a late click can't double-submit.
      resetTimer.current = setTimeout(() => {
        submittingRef.current = false;
        setSubmitting(false);
      }, 8000);
    }
  };

  const isPlan = prompt.kind === 'plan';
  const isPending = prompt.status === 'pending';
  const isAnswered = prompt.status === 'answered';
  const isCancelled = prompt.status === 'cancelled';

  const tone = isPending
    ? isPlan
      ? 'border-yellow-500/40 bg-yellow-500/5'
      : 'border-blue-500/40 bg-blue-500/5'
    : isAnswered
      ? 'border-emerald-500/30 bg-emerald-500/5'
      : 'border-muted bg-muted/20';
  const Icon = isPlan ? Crown : HelpCircle;
  const iconColor = isPlan ? 'text-yellow-400' : 'text-blue-400';
  const headerLabel = isPlan
    ? t('agents:company.planApproval')
    : t('agents:company.masterQuestion');

  return (
    <div className={cn('rounded-lg border-2 p-3 text-xs space-y-2', tone)}>
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="text-[10px] px-1.5 bg-purple-500/20 text-purple-400 border-purple-500/30">
          @master
        </Badge>
        <Icon className={cn('h-3 w-3', iconColor)} />
        <span className="text-[11px] font-medium">{headerLabel}</span>
        {isAnswered && (
          <Badge variant="outline" className="text-[10px] gap-1 border-emerald-500/40 text-emerald-500">
            <CheckCircle className="h-2.5 w-2.5" /> {t('common:actions.answered', 'Answered')}
          </Badge>
        )}
        {isCancelled && (
          <Badge variant="outline" className="text-[10px] gap-1 text-muted-foreground">
            <Ban className="h-2.5 w-2.5" /> {t('agents:company.promptCancelled', 'Cancelled')}
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">
          {formatClock(prompt.created_at)}
        </span>
      </div>

      {isPlan ? (
        <div className="bg-background rounded-md border p-2.5 whitespace-pre-wrap max-h-60 overflow-y-auto">
          {prompt.body}
        </div>
      ) : (
        <p className="whitespace-pre-wrap">{prompt.body}</p>
      )}

      {/* Option buttons (questions only, when pending) */}
      {isPending && !isPlan && prompt.options && prompt.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {prompt.options.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => submit(() => onAnswerQuestion(opt.value))}
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : opt.label}
            </Button>
          ))}
        </div>
      )}

      {/* Pending — questions: freeform answer */}
      {isPending && !isPlan && (prompt.allow_freeform || !prompt.options || prompt.options.length === 0) && (
        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('agents:company.answerPlaceholder')}
            disabled={submitting}
            className="flex-1 rounded-md border bg-background px-3 py-1.5 text-xs resize-none disabled:opacity-60"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim() && !submitting) {
                e.preventDefault();
                submit(() => onAnswerQuestion(text.trim()));
              }
            }}
          />
          <Button
            size="sm"
            variant="default"
            onClick={() => text.trim() && submit(() => onAnswerQuestion(text.trim()))}
            disabled={submitting || !text.trim()}
            className="self-end gap-1"
          >
            {submitting
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('agents:company.answering', 'Enviando…')}</>
              : <><Send className="h-3.5 w-3.5" /> {t('agents:company.answer')}</>}
          </Button>
        </div>
      )}

      {/* Pending — plans: approve/reject + feedback */}
      {isPending && isPlan && (
        <>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t('agents:company.feedbackPlaceholder')}
            disabled={submitting}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-xs resize-none disabled:opacity-60"
            rows={2}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="default" disabled={submitting} onClick={() => submit(() => onRespondPlan(true, feedback || undefined))} className="gap-1">
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />} {t('common:actions.approve')}
            </Button>
            <Button size="sm" variant="outline" disabled={submitting} onClick={() => submit(() => onRespondPlan(false, feedback || undefined))} className="gap-1 text-destructive">
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />} {t('common:actions.reject')}
            </Button>
          </div>
        </>
      )}

      {/* Answered — show what the human chose */}
      {isAnswered && !isPlan && prompt.answer != null && (
        <div className="rounded-md bg-background border px-3 py-2 whitespace-pre-wrap">
          <span className="text-muted-foreground mr-1">›</span>
          {prompt.answer}
        </div>
      )}
      {isAnswered && isPlan && (
        <div className="rounded-md bg-background border px-3 py-2">
          <span className={cn('font-medium', prompt.approved ? 'text-emerald-500' : 'text-destructive')}>
            {prompt.approved ? t('common:actions.approved', 'Approved') : t('common:actions.rejected', 'Rejected')}
          </span>
          {prompt.feedback && (
            <span className="text-muted-foreground"> — {prompt.feedback}</span>
          )}
        </div>
      )}

      {/* Cancelled — neutral note */}
      {isCancelled && (
        <p className="text-muted-foreground italic">
          {t(
            'agents:company.promptCancelledNote',
            'Session ended before this was answered.',
          )}
        </p>
      )}
    </div>
  );
});
