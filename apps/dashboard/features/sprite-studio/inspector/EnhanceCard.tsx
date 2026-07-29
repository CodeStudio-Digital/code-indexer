/**
 * Inspector edit-mode card: whole-image AI enhance ("mais contraste, roupa
 * medieval") — img2img of the asset's active version with a prompt. Starts a
 * backend job (startEnhanceJob) and follows it inline with an
 * EnhanceResultsStrip: candidates arrive over SSE, Apply promotes one into a
 * new version without leaving edit mode.
 *
 * Props the parent (InspectorPanel) must pass:
 *   asset            SpriteAsset | null — null → card hidden
 *   activeVersionId  number | null      — version to enhance (falls back to
 *                                         asset.currentVersionId)
 *   projectId?       number             — IDE project id; UNWIRED today (the
 *                                         orchestrator lands it later), so the
 *                                         card falls back to the `?project=`
 *                                         URL param SpriteStudioView keeps in
 *                                         sync (its deep-link contract)
 *   onApplied?       (versionId) => void — unwired today; a toast points the
 *                                         user at Reload/Versions meanwhile
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, Wand2 } from 'lucide-react';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { startEnhanceJob, type EnhanceJobRef } from '../api-enhance.js';
import { useSpriteJobs } from '../jobs/useSpriteJobs.js';
import { EnhanceResultsStrip } from '../edit/EnhanceResultsStrip.js';
import type { SpriteAsset } from '../types.js';
import { InspectorSection } from './InspectorSection.js';

const VARIANT_CHOICES = [1, 2, 3, 4];

export function EnhanceCard({
  asset,
  activeVersionId,
  projectId,
  onApplied,
}: {
  asset: SpriteAsset | null;
  activeVersionId: string | null;
  projectId?: number;
  onApplied?: (versionId: string) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [n, setN] = useState(2);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<EnhanceJobRef | null>(null);
  // SSE goes live only once a job is being followed (see strip docblock).
  const jobs = useSpriteJobs(active?.projectId ?? null);

  if (!asset) return null;

  const urlProject = Number(searchParams.get('project'));
  const effectiveProjectId =
    projectId ?? (Number.isFinite(urlProject) && urlProject > 0 ? urlProject : null);
  const versionId = activeVersionId ?? asset.currentVersionId;
  const canRun =
    effectiveProjectId != null && versionId != null && prompt.trim().length > 0 && !busy;

  const run = async () => {
    if (!canRun || effectiveProjectId == null || versionId == null) return;
    setBusy(true);
    try {
      const ref = await startEnhanceJob(effectiveProjectId, asset.id, versionId, prompt.trim(), n);
      setActive(ref);
    } catch (e) {
      toast.error(t('enhance.startFailed'), { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <InspectorSection id="enhance" icon={Wand2} title={t('enhance.title')}>
      <Input
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
        placeholder={t('enhance.promptPlaceholder')}
        className="h-7 text-xs"
        disabled={busy}
      />

      <div className="flex items-center gap-1">
        <select
          className="h-6 w-14 rounded border bg-background px-1 text-[11px]"
          value={n}
          onChange={(e) => setN(Number(e.target.value))}
          aria-label={t('enhance.variantsLabel')}
          disabled={busy}
        >
          {VARIANT_CHOICES.map((k) => <option key={k} value={k}>{`${k}×`}</option>)}
        </select>
        <Button
          size="sm"
          className="h-6 flex-1 gap-1 text-[11px]"
          disabled={!canRun}
          title={t('enhance.run')}
          onClick={() => void run()}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          {t('enhance.run')}
        </Button>
      </div>

      {versionId == null && (
        <p className="text-[11px] text-muted-foreground">{t('enhance.noVersion')}</p>
      )}

      {active && (
        <div className="rounded border">
          <EnhanceResultsStrip
            projectId={active.projectId}
            assetId={active.assetId}
            jobId={active.jobId}
            jobs={jobs}
            onApplied={onApplied}
            onClose={() => setActive(null)}
          />
        </div>
      )}
    </InspectorSection>
  );
}
