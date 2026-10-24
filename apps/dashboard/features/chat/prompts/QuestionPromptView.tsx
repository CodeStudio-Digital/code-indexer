import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, HelpCircle } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Markdown } from '../messages/Markdown.js';
import {
  getPromptDraft,
  markPromptResolved,
  setPromptDraft,
} from '../../../hooks/agent-stream/prompt-resolution-store.js';
import { usePromptResolution } from '../../../hooks/agent-stream/usePromptResolution.js';
import { usePromptSubmission } from '../../../hooks/agent-stream/usePromptSubmission.js';

interface QuestionPromptViewProps {
  question: {
    id: string;
    question: string;
    header?: string;
    options?: Array<{ label: string; value: string }>;
    allowFreeform?: boolean;
    /** When true + options: user picks MULTIPLE and confirms (checkbox-style). */
    multiSelect?: boolean;
    resolved?: string;
  };
  onAnswer: (answer: string, interactionId?: string) => Promise<void>;
  /** Bridges this card to its persisted twin, which carries a different id. */
  signature?: string;
  sessionId?: string;
}

interface QuestionDraft {
  text: string;
  selected: string[];
}

export function QuestionPromptView({
  question,
  onAnswer,
  signature,
  sessionId,
}: QuestionPromptViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  // Virtualization unmounts this card when it scrolls out of view, so the draft
  // and the answer both live in a store that outlives the component.
  const draft = getPromptDraft<QuestionDraft>(question.id);
  const [text, setText] = useState(draft?.text ?? '');
  const [selected, setSelected] = useState<string[]>(draft?.selected ?? []);
  const storedResolution = usePromptResolution<string>(question.id, signature, sessionId);
  const resolved = question.resolved ?? storedResolution;
  const submission = usePromptSubmission();

  useEffect(() => {
    setPromptDraft(question.id, { text, selected });
  }, [question.id, selected, text]);

  const submit = (val: string) => submission.submit(async () => {
    await onAnswer(val, question.id);
    markPromptResolved({ id: question.id, signature, sessionId, resolution: val });
  });
  const hasOptions = !!question.options && question.options.length > 0;
  const multi = !!question.multiSelect && hasOptions;

  // Multi-select: options toggle (by label — the readable answer both the user
  // and the agent see); a confirm button submits the joined labels + freeform.
  const toggleLabel = (label: string) =>
    setSelected((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]));
  const confirmMulti = () => {
    const parts = [...selected, text.trim()].filter(Boolean);
    if (parts.length > 0) void submit(parts.join(', '));
  };

  return (
    <div className="my-3 rounded-xl border border-info/40 bg-info/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-info/15 text-info flex items-center justify-center">
          <HelpCircle className="h-4 w-4" />
        </div>
        <div className="text-xs font-semibold text-info uppercase tracking-wider">
          {question.header?.trim() || t('chat:question.title')}
        </div>
      </div>
      <div className="text-sm text-foreground mb-3 px-1 prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ol:my-1 prose-ul:my-1 prose-li:my-0.5">
        <Markdown text={question.question} />
      </div>
      {resolved ? (
        <div className="text-xs text-info flex items-center gap-1.5 px-1">
          <Check className="h-3.5 w-3.5" /> <span className="font-medium">{t('chat:question.answered')}</span> {resolved}
        </div>
      ) : (
        <>
          {hasOptions && (
            <>
              {multi && (
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 px-1">
                  {t('chat:question.multiHint')}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                {question.options!.map((o, i) => {
                  const active = multi && selected.includes(o.label);
                  return (
                    <button
                      key={o.value}
                      disabled={submission.submitting}
                      onClick={() => (multi ? toggleLabel(o.label) : submit(o.value))}
                      className={`group flex items-start gap-2.5 text-left px-3 py-2.5 rounded-lg border transition-colors ${
                        active
                          ? 'border-info bg-info/10'
                          : 'border-info/30 bg-background hover:bg-info/10 hover:border-info'
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex-shrink-0 h-5 w-5 rounded-full text-[11px] font-semibold flex items-center justify-center ${
                          active
                            ? 'bg-info text-primary-foreground'
                            : 'bg-info/15 text-info group-hover:bg-info group-hover:text-primary-foreground'
                        }`}
                      >
                        {active ? <Check className="h-3 w-3" /> : String.fromCharCode(65 + i)}
                      </span>
                      <span className="text-sm text-foreground flex-1">{o.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div>
            {hasOptions && (
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 px-1">
                {t('chat:question.customAnswer')}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                disabled={submission.submitting}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  if (multi) confirmMulti();
                  else if (text.trim()) void submit(text.trim());
                }}
                placeholder={t('chat:question.answerPlaceholder')}
                className="text-sm"
              />
              {multi ? (
                <Button
                  size="sm"
                  onClick={confirmMulti}
                  disabled={submission.submitting || (selected.length === 0 && !text.trim())}
                >
                  {t('chat:question.confirm')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => text.trim() && void submit(text.trim())} disabled={submission.submitting || !text.trim()}>
                  {t('common:actions.send')}
                </Button>
              )}
            </div>
          </div>
          {submission.error && <p role="alert" className="mt-2 text-xs text-destructive">{submission.error}</p>}
        </>
      )}
    </div>
  );
}
