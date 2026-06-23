import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, GitFork } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Markdown } from '../messages/Markdown.js';
import type { DecisionPrompt, DecisionAnswers } from '../../../hooks/agent-stream/types.js';

interface DecisionGateViewProps {
  decision: DecisionPrompt;
  onConfirm: (answers: DecisionAnswers) => Promise<void>;
}

/**
 * Renders a `decision_gate` questionnaire: 1–4 forks in one card, each option
 * carrying a summary + tradeoffs, single- or multi-select per question, with an
 * optional free-form note. Mirrors QuestionPromptView's live/resolved split —
 * once confirmed (or when rehydrated from history with `resolved`), it collapses
 * to a read-only summary of the chosen approaches.
 */
export function DecisionGateView({ decision, onConfirm }: DecisionGateViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const q of decision.questions) init[q.id] = decision.resolved?.[q.id]?.selected ?? [];
    return init;
  });
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of decision.questions) init[q.id] = decision.resolved?.[q.id]?.freeform ?? '';
    return init;
  });
  const [resolved, setResolved] = useState<DecisionAnswers | undefined>(decision.resolved);
  const [submitting, setSubmitting] = useState(false);

  const toggle = (qId: string, value: string, multi: boolean) => {
    setSelections((prev) => {
      const cur = prev[qId] ?? [];
      if (multi) {
        return { ...prev, [qId]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
      }
      return { ...prev, [qId]: [value] };
    });
  };

  const allAnswered = decision.questions.every((q) => (selections[q.id]?.length ?? 0) > 0);

  const confirm = async () => {
    if (!allAnswered || submitting) return;
    const answers: DecisionAnswers = {};
    for (const q of decision.questions) {
      const note = (notes[q.id] ?? '').trim();
      answers[q.id] = { selected: selections[q.id] ?? [], ...(note ? { freeform: note } : {}) };
    }
    setSubmitting(true);
    try {
      await onConfirm(answers);
      setResolved(answers);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="my-3 rounded-xl border border-info/40 bg-info/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-info/15 text-info flex items-center justify-center">
          <GitFork className="h-4 w-4" />
        </div>
        <div className="text-xs font-semibold text-info uppercase tracking-wider">
          {decision.header?.trim() || t('chat:decision.title')}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {decision.questions.map((q) => {
          const sel = selections[q.id] ?? [];
          const multi = !!q.multiSelect;
          return (
            <div key={q.id} className="rounded-lg border border-info/20 bg-background/40 p-3">
              <div className="text-sm text-foreground mb-1 prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ol:my-1 prose-ul:my-1 prose-li:my-0.5">
                {q.header?.trim() && <div className="text-[11px] font-semibold text-info uppercase tracking-wide mb-1">{q.header}</div>}
                <Markdown text={q.question} />
              </div>
              {!resolved && (
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                  {multi ? t('chat:decision.multiHint') : t('chat:decision.selectHint')}
                </div>
              )}
              <div className="grid grid-cols-1 gap-2">
                {q.options.map((o, i) => {
                  const active = sel.includes(o.value);
                  const locked = !!resolved;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      disabled={locked}
                      onClick={() => toggle(q.id, o.value, multi)}
                      className={`group flex items-start gap-2.5 text-left px-3 py-2.5 rounded-lg border transition-colors ${
                        active
                          ? 'border-info bg-info/10'
                          : 'border-info/30 bg-background hover:bg-info/10 hover:border-info'
                      } ${locked ? 'cursor-default opacity-90' : ''}`}
                    >
                      <span
                        className={`mt-0.5 flex-shrink-0 h-5 w-5 rounded-full text-[11px] font-semibold flex items-center justify-center ${
                          active ? 'bg-info text-primary-foreground' : 'bg-info/15 text-info group-hover:bg-info group-hover:text-primary-foreground'
                        }`}
                      >
                        {active ? <Check className="h-3 w-3" /> : String.fromCharCode(65 + i)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-foreground">{o.label}</span>
                        {o.summary && <span className="block text-xs text-muted-foreground mt-0.5">{o.summary}</span>}
                        {o.tradeoffs && <span className="block text-[11px] text-muted-foreground/80 mt-1 whitespace-pre-wrap">{o.tradeoffs}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
              {decision.allowFreeform && !resolved && (
                <div className="mt-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    {t('chat:decision.customAnswer')}
                  </div>
                  <Input
                    value={notes[q.id] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder={t('chat:decision.answerPlaceholder')}
                    className="text-sm"
                  />
                </div>
              )}
              {resolved?.[q.id]?.freeform && (
                <div className="mt-2 text-xs text-muted-foreground">
                  <span className="opacity-70">{t('chat:decision.customAnswer')}: </span>
                  {resolved[q.id].freeform}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {resolved ? (
        <div className="text-xs text-info flex items-center gap-1.5 px-1 mt-3">
          <Check className="h-3.5 w-3.5" /> <span className="font-medium">{t('chat:decision.confirmed')}</span>
        </div>
      ) : (
        <div className="flex justify-end mt-3">
          <Button size="sm" onClick={confirm} disabled={!allAnswered || submitting}>
            {t('chat:decision.confirm')}
          </Button>
        </div>
      )}
    </div>
  );
}
