import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, GitFork } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { Markdown } from '../messages/Markdown.js';
import type { DecisionPrompt, DecisionAnswers, DecisionQuestion } from '../../../hooks/agent-stream/types.js';
import {
  getPromptDraft,
  markPromptResolved,
  setPromptDraft,
} from '../../../hooks/agent-stream/prompt-resolution-store.js';
import { usePromptResolution } from '../../../hooks/agent-stream/usePromptResolution.js';

interface DecisionGateViewProps {
  decision: DecisionPrompt;
  onConfirm: (answers: DecisionAnswers) => Promise<void>;
  /** Bridges this card to its persisted twin, which carries a different id. */
  signature?: string;
  sessionId?: string;
}

interface DecisionDraft {
  selections: Record<string, string[]>;
  notes: Record<string, string>;
  currentIndex: number;
}

type SelectionState = Record<string, string[]>;
type NoteState = Record<string, string>;

export function decisionQuestionHasAnswer(
  q: DecisionQuestion,
  selections: SelectionState,
  notes: NoteState,
  allowFreeform?: boolean,
): boolean {
  const selected = selections[q.id]?.length ?? 0;
  const freeform = (notes[q.id] ?? '').trim().length;
  return selected > 0 || Boolean(allowFreeform && freeform > 0);
}

export function buildDecisionAnswers(
  questions: DecisionQuestion[],
  selections: SelectionState,
  notes: NoteState,
): DecisionAnswers {
  const answers: DecisionAnswers = {};
  for (const q of questions) {
    const note = (notes[q.id] ?? '').trim();
    answers[q.id] = { selected: selections[q.id] ?? [], ...(note ? { freeform: note } : {}) };
  }
  return answers;
}

/**
 * Renders a `decision_gate` questionnaire as a step-by-step decision wizard.
 * Pending cards show one fork at a time with Back/Next controls and optional
 * custom answers; resolved cards collapse to a readable decision summary.
 */
export function DecisionGateView({
  decision,
  onConfirm,
  signature,
  sessionId,
}: DecisionGateViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  // Scrolling this card out of view unmounts it, so a wizard half-way through
  // its forks would lose every selection. The draft store outlives the mount.
  const draft = getPromptDraft<DecisionDraft>(decision.id);
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const q of decision.questions) {
      init[q.id] = draft?.selections?.[q.id] ?? decision.resolved?.[q.id]?.selected ?? [];
    }
    return init;
  });
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of decision.questions) {
      init[q.id] = draft?.notes?.[q.id] ?? decision.resolved?.[q.id]?.freeform ?? '';
    }
    return init;
  });
  const storedResolution = usePromptResolution<DecisionAnswers>(decision.id, signature, sessionId);
  const resolved = decision.resolved ?? storedResolution;
  const [currentIndex, setCurrentIndex] = useState(draft?.currentIndex ?? 0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setPromptDraft(decision.id, { selections, notes, currentIndex });
  }, [currentIndex, decision.id, notes, selections]);

  const questions = decision.questions;
  const total = Math.max(questions.length, 1);
  const safeIndex = Math.min(currentIndex, total - 1);
  const activeQuestion = questions[safeIndex];
  const isLast = safeIndex >= questions.length - 1;

  const toggle = (qId: string, value: string, multi: boolean) => {
    setSelections((prev) => {
      const cur = prev[qId] ?? [];
      if (multi) {
        return { ...prev, [qId]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
      }
      return { ...prev, [qId]: [value] };
    });
  };

  const hasAnswer = (q: DecisionQuestion) => decisionQuestionHasAnswer(q, selections, notes, decision.allowFreeform);

  const allAnswered = questions.length > 0 && questions.every(hasAnswer);
  const activeAnswered = !!activeQuestion && hasAnswer(activeQuestion);

  const confirm = async () => {
    if (!allAnswered || submitting) return;
    const answers = buildDecisionAnswers(questions, selections, notes);
    setSubmitting(true);
    try {
      await onConfirm(answers);
      markPromptResolved({ id: decision.id, signature, sessionId, resolution: answers });
    } finally {
      setSubmitting(false);
    }
  };

  const goNext = () => {
    if (!activeAnswered || submitting) return;
    if (isLast) {
      void confirm();
      return;
    }
    setCurrentIndex((i) => Math.min(i + 1, questions.length - 1));
  };

  const goBack = () => setCurrentIndex((i) => Math.max(i - 1, 0));

  const renderChoiceSummary = (q: DecisionQuestion, answer?: { selected: string[]; freeform?: string }) => {
    const selected = answer?.selected ?? [];
    const labels = q.options.filter((o) => selected.includes(o.value)).map((o) => o.label);
    const custom = answer?.freeform?.trim();
    if (labels.length === 0 && !custom) return t('chat:decision.noSelection');
    return (
      <div className="space-y-1">
        {labels.length > 0 && <div className="font-medium text-foreground">{labels.join(', ')}</div>}
        {custom && <div className="text-muted-foreground whitespace-pre-wrap">{custom}</div>}
      </div>
    );
  };

  if (resolved) {
    return (
      <div className="my-3 overflow-hidden rounded-xl border border-info/30 bg-info/5">
        <div className="flex items-center justify-between gap-3 border-b border-info/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-info/15 text-info flex items-center justify-center">
              <GitFork className="h-4 w-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-info uppercase tracking-wider">
                {decision.header?.trim() || t('chat:decision.title')}
              </div>
              <div className="text-[11px] text-muted-foreground">{t('chat:decision.summary')}</div>
            </div>
          </div>
          <div className="text-xs text-info flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5" /> <span className="font-medium">{t('chat:decision.confirmed')}</span>
          </div>
        </div>
        <div className="divide-y divide-info/15">
          {questions.map((q, i) => (
            <div key={q.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,0.8fr),minmax(0,1fr)]">
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-info/80">
                  {t('chat:decision.stepLabel', { current: i + 1, total: questions.length })}
                </div>
                {q.header?.trim() && <div className="mt-1 text-xs font-semibold text-foreground">{q.header}</div>}
                <div className="mt-1 text-xs text-muted-foreground">
                  <Markdown text={q.question} />
                </div>
              </div>
              <div className="rounded-lg border border-info/20 bg-background/60 px-3 py-2 text-sm">
                {renderChoiceSummary(q, resolved[q.id])}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!activeQuestion) return null;

  const sel = selections[activeQuestion.id] ?? [];
  const multi = !!activeQuestion.multiSelect;
  const freeform = notes[activeQuestion.id] ?? '';

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-info/40 bg-info/5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-info/20 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-info/15 text-info flex items-center justify-center">
            <GitFork className="h-4 w-4" />
          </div>
          <div>
            <div className="text-xs font-semibold text-info uppercase tracking-wider">
              {decision.header?.trim() || t('chat:decision.title')}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t('chat:decision.stepLabel', { current: safeIndex + 1, total: questions.length })}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5" aria-hidden="true">
          {questions.map((q, i) => (
            <span
              key={q.id}
              className={`h-1.5 rounded-full transition-all ${
                i === safeIndex ? 'w-6 bg-info' : hasAnswer(q) ? 'w-2 bg-info/60' : 'w-2 bg-info/20'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="p-4">
        <div className="rounded-lg border border-info/20 bg-background/50 p-3">
          <div className="text-sm text-foreground prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ol:my-1 prose-ul:my-1 prose-li:my-0.5">
            {activeQuestion.header?.trim() && (
              <div className="text-[11px] font-semibold text-info uppercase tracking-wide mb-1">
                {activeQuestion.header}
              </div>
            )}
            <Markdown text={activeQuestion.question} />
          </div>
          <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            {multi ? t('chat:decision.multiHint') : t('chat:decision.selectHint')}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2">
          {activeQuestion.options.map((o, i) => {
            const active = sel.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggle(activeQuestion.id, o.value, multi)}
                className={`group flex items-start gap-2.5 text-left px-3 py-2.5 rounded-lg border transition-colors ${
                  active
                    ? 'border-info bg-info/10'
                    : 'border-info/30 bg-background hover:bg-info/10 hover:border-info'
                }`}
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

        {decision.allowFreeform && (
          <div className="mt-3 rounded-lg border border-info/20 bg-background/50 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              {t('chat:decision.customAnswer')}
            </div>
            <Textarea
              value={freeform}
              onChange={(e) => setNotes((prev) => ({ ...prev, [activeQuestion.id]: e.target.value }))}
              placeholder={t('chat:decision.answerPlaceholder')}
              className="min-h-[84px] text-sm"
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-info/20 px-4 py-3">
        <Button size="sm" variant="outline" onClick={goBack} disabled={safeIndex === 0 || submitting}>
          <ChevronLeft className="h-3.5 w-3.5" />
          {t('chat:decision.back')}
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {activeAnswered ? t('chat:decision.stepReady') : t('chat:decision.stepRequired')}
          </span>
          <Button size="sm" onClick={goNext} disabled={!activeAnswered || submitting}>
            {isLast ? t('chat:decision.confirm') : t('chat:decision.next')}
            {!isLast && <ChevronRight className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
