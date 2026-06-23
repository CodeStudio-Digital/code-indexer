/**
 * Natural-language → pipeline draft bar shown atop the builder canvas.
 * Self-contained (owns its input + loading state); delegates the actual
 * generation to `onGenerate`, which loads the returned graph and surfaces
 * any refusal/validation issues in the builder.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { Button } from '../../../../components/ui/button.js';
import { Input } from '../../../../components/ui/input.js';

interface AiGenerateBarProps {
  onGenerate: (intent: string) => Promise<void>;
}

export function AiGenerateBar({ onGenerate }: AiGenerateBarProps) {
  const { t } = useTranslation('agents');
  const [intent, setIntent] = useState('');
  const [generating, setGenerating] = useState(false);

  const run = async () => {
    const value = intent.trim();
    if (!value || generating) return;
    setGenerating(true);
    try {
      await onGenerate(value);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
      <Sparkles className="h-3.5 w-3.5 text-info shrink-0" />
      <Input
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run();
        }}
        className="h-7 flex-1 text-xs"
        placeholder={t('pipelines.ai.placeholder', {
          defaultValue: 'Describe a workflow and let AI draft the stages…',
        })}
      />
      <Button size="sm" variant="secondary" disabled={generating || !intent.trim()} onClick={run}>
        {generating
          ? t('pipelines.ai.generating', { defaultValue: 'Generating…' })
          : t('pipelines.ai.generate', { defaultValue: 'Generate' })}
      </Button>
    </div>
  );
}
