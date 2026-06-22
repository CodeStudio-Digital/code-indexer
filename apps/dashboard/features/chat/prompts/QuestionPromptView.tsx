import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, HelpCircle } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Markdown } from '../messages/Markdown.js';

interface QuestionPromptViewProps {
  question: {
    id: string;
    question: string;
    header?: string;
    options?: Array<{ label: string; value: string }>;
    allowFreeform?: boolean;
    resolved?: string;
  };
  onAnswer: (answer: string) => Promise<void>;
}

export function QuestionPromptView({ question, onAnswer }: QuestionPromptViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [text, setText] = useState('');
  const [resolved, setResolved] = useState<string | undefined>(question.resolved);
  const submit = async (val: string) => {
    await onAnswer(val);
    setResolved(val);
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
          {question.options && question.options.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
              {question.options.map((o, i) => (
                <button
                  key={o.value}
                  onClick={() => submit(o.value)}
                  className="group flex items-start gap-2.5 text-left px-3 py-2.5 rounded-lg border border-info/30 bg-background hover:bg-info/10 hover:border-info transition-colors"
                >
                  <span className="mt-0.5 flex-shrink-0 h-5 w-5 rounded-full bg-info/15 text-info text-[11px] font-semibold flex items-center justify-center group-hover:bg-info group-hover:text-primary-foreground">
                    {String.fromCharCode(65 + i)}
                  </span>
                  <span className="text-sm text-foreground flex-1">{o.label}</span>
                </button>
              ))}
            </div>
          )}
          <div>
            {question.options && question.options.length > 0 && (
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 px-1">
                {t('chat:question.customAnswer')}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && text.trim()) submit(text.trim());
                }}
                placeholder={t('chat:question.answerPlaceholder')}
                className="text-sm"
              />
              <Button size="sm" onClick={() => text.trim() && submit(text.trim())} disabled={!text.trim()}>
                {t('common:actions.send')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
