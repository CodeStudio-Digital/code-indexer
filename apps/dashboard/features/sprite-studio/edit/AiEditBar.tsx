/**
 * AI inpaint bar — mounts while a selection exists (editor-store
 * .hasSelection) or an inpaint job is being followed. Exports the selection
 * as a black/white mask PNG and hands it plus the prompt to the `onInpaint`
 * prop; when `onInpaint` is undefined the button reads "coming soon".
 *
 * Result flow: the started job's candidates render right below the bar in an
 * EnhanceResultsStrip (pick → new version, no mode change). The jobId reaches
 * the bar two ways: (a) the awaited `onInpaint` result, when the caller
 * returns startInpaintJob's ref — future orchestrator wiring; and (b) the
 * api-enhance `onEnhanceJobStarted` module notification, which is what works
 * TODAY because EditModeView's prop chain is frozen at `void|Promise<void>`
 * and cannot carry the ref type-safely. `onApplied` is optional and unwired
 * for now (the orchestrator connects it later); a toast tells the user to
 * reload/see Versions meanwhile.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { maskToPngBlob } from '../engine/selection-mask.js';
import type { EditorEngine } from '../engine/EditorEngine.js';
import { useSpriteEditorStore } from '../store/editor-store.js';
import { onEnhanceJobStarted } from '../api-enhance.js';
import { useSpriteJobs } from '../jobs/useSpriteJobs.js';
import { EnhanceResultsStrip } from './EnhanceResultsStrip.js';

interface ActiveJob { jobId: number; projectId: number; assetId: number }

export function AiEditBar({
  engine,
  onInpaint,
  projectId,
  assetId,
  onApplied,
}: {
  engine: EditorEngine;
  /**
   * Absent → the button shows "coming soon" and stays disabled. May resolve
   * with the started job ref so the bar can follow it (see module docblock).
   */
  onInpaint?: (
    maskBlob: Blob,
    prompt: string,
  ) => void | Promise<{ jobId: number; projectId?: number; assetId?: number } | void>;
  /** Optional strip context — falls back to the job-start notification. */
  projectId?: number;
  assetId?: number;
  /** Fires with the new version id after a candidate is applied (unwired today). */
  onApplied?: (versionId: number) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const hasSelection = useSpriteEditorStore((s) => s.hasSelection);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<ActiveJob | null>(null);
  // SSE goes live only once a job (with its projectId) is being followed.
  const jobs = useSpriteJobs(active?.projectId ?? null);

  // Delivery path that works through the frozen EditModeView prop chain.
  useEffect(
    () => onEnhanceJobStarted((ref) => { if (ref.kind === 'inpaint') setActive(ref); }),
    [],
  );

  if (!hasSelection && !active) return null;

  const run = async () => {
    if (!onInpaint || busy || !prompt.trim()) return;
    const mask = engine.selection.snapshot();
    if (!mask) return;
    setBusy(true);
    try {
      const blob = await maskToPngBlob(mask, engine.selection.width, engine.selection.height);
      const res = await onInpaint(blob, prompt.trim());
      if (res && typeof res.jobId === 'number') {
        const pid = res.projectId ?? projectId;
        const aid = res.assetId ?? assetId;
        if (pid != null && aid != null) setActive({ jobId: res.jobId, projectId: pid, assetId: aid });
      }
    } catch (e) {
      toast.error(t('ai.startFailed'), { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t bg-primary/5">
      {hasSelection && (
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
            placeholder={t('ai.promptPlaceholder')}
            className="h-7 flex-1 text-xs"
            disabled={busy}
          />
          <Button
            size="sm"
            className="h-7 gap-1"
            disabled={!onInpaint || busy || !prompt.trim()}
            title={onInpaint ? t('ai.edit') : t('ai.comingSoon')}
            onClick={() => void run()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {onInpaint ? t('ai.edit') : t('ai.comingSoon')}
          </Button>
        </div>
      )}
      {active && (
        <EnhanceResultsStrip
          projectId={active.projectId}
          assetId={active.assetId}
          jobId={active.jobId}
          jobs={jobs}
          onApplied={onApplied}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
