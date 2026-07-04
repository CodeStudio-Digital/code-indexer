/**
 * PromptComposer — the prompt textarea + generation controls: variant count
 * (1/2/4/8 segmented), an optional seed with a lock toggle, a "send prompt
 * as-is" (rawPrompt) toggle, and the Generate button. It owns none of the job
 * state; on submit it hands the assembled params to the parent's `onGenerate`.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Lock, LockOpen, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { cn } from '../../../lib/utils.js';

export interface GenerateInput {
  prompt: string;
  n: number;
  rawPrompt: boolean;
  seed: number | null;
}

const VARIANT_COUNTS = [1, 2, 4, 8] as const;

export function PromptComposer({
  running,
  onGenerate,
  initialDraft,
  onDraftChange,
}: {
  running: boolean;
  onGenerate: (input: GenerateInput) => void;
  /** Restored draft (prompt/count survive navigation via ui-state). */
  initialDraft?: { prompt: string; n: number; rawPrompt: boolean } | null;
  /** Fires on every draft edit so the parent can persist it. */
  onDraftChange?: (draft: { prompt: string; n: number; rawPrompt: boolean }) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? '');
  const [n, setN] = useState(initialDraft?.n ?? 4);
  const [rawPrompt, setRawPrompt] = useState(initialDraft?.rawPrompt ?? false);
  const [seedLocked, setSeedLocked] = useState(false);
  const [seed, setSeed] = useState('');

  const draft = (patch: Partial<{ prompt: string; n: number; rawPrompt: boolean }>) => {
    onDraftChange?.({ prompt, n, rawPrompt, ...patch });
  };

  const canGenerate = prompt.trim() !== '' && !running;

  const submit = () => {
    if (!canGenerate) return;
    const parsedSeed = seedLocked && seed.trim() !== '' ? Number(seed) : null;
    onGenerate({
      prompt: prompt.trim(),
      n,
      rawPrompt,
      seed: Number.isFinite(parsedSeed as number) ? parsedSeed : null,
    });
  };

  return (
    <div className="space-y-2">
      <Textarea
        value={prompt}
        onChange={(e) => { setPrompt(e.target.value); draft({ prompt: e.target.value }); }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
        }}
        placeholder={t('generate.composer.promptPlaceholder')}
        className="min-h-[84px] text-sm"
      />

      <div className="flex flex-wrap items-center gap-2">
        {/* Variant count segmented control */}
        <div className="inline-flex overflow-hidden rounded-md border">
          {VARIANT_COUNTS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setN(c); draft({ n: c }); }}
              title={t('generate.composer.variants', { n: c })}
              className={cn(
                'px-2.5 py-1 text-xs transition-colors',
                n === c ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
              )}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Seed + lock */}
        <div className="inline-flex items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant={seedLocked ? 'secondary' : 'ghost'}
            title={t(seedLocked ? 'generate.composer.seedLocked' : 'generate.composer.seedUnlocked')}
            onClick={() => setSeedLocked((v) => !v)}
          >
            {seedLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
          </Button>
          <Input
            type="number"
            disabled={!seedLocked}
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder={t('generate.composer.seedPlaceholder')}
            className="h-8 w-24 text-xs"
          />
        </div>

        {/* Raw prompt toggle */}
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={rawPrompt}
            onChange={(e) => { setRawPrompt(e.target.checked); draft({ rawPrompt: e.target.checked }); }}
            className="h-3.5 w-3.5 accent-primary"
          />
          {t('generate.composer.rawPrompt')}
        </label>

        <Button size="sm" className="ml-auto gap-1.5" disabled={!canGenerate} onClick={submit}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('generate.composer.generate')}
        </Button>
      </div>
    </div>
  );
}
