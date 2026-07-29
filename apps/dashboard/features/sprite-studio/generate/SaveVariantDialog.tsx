/**
 * SaveVariantDialog — pick a target for a chosen candidate. "New asset"
 * (name + category, prefilled from the prompt) creates the asset first, then
 * promotes the candidate; "New version of <activeAsset>" promotes straight
 * onto the existing asset. Both call api.pickCandidate and report the created
 * (assetId, versionId) back to the parent via onSaved.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import * as api from '../api.js';
import { CATEGORY_GROUPS, type SpriteAsset, type SpriteCategory, type StudioSettings } from '../types.js';
import type { JobCandidate } from '../jobs/useSpriteJobs.js';

type Target = 'new' | 'existing';

/** Turn a prompt into a short human-ish default asset name. */
function nameFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 4).join(' ');
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export function SaveVariantDialog({
  open,
  onOpenChange,
  projectId,
  jobId,
  candidate,
  prompt,
  settings,
  activeAsset,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: number;
  jobId: string;
  candidate: JobCandidate | null;
  prompt: string;
  settings: StudioSettings | null;
  activeAsset: SpriteAsset | null;
  onSaved: (assetId: string, versionId: string) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [target, setTarget] = useState<Target>(activeAsset ? 'existing' : 'new');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<SpriteCategory>('character');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget(activeAsset ? 'existing' : 'new');
    setName(nameFromPrompt(prompt));
    setCategory('character');
    setError(null);
  }, [open, activeAsset, prompt]);

  const valid = target === 'existing' ? !!activeAsset : name.trim() !== '';

  const save = async () => {
    if (!valid || busy || !candidate) return;
    setBusy(true);
    setError(null);
    try {
      let assetId: string;
      if (target === 'existing' && activeAsset) {
        assetId = activeAsset.id;
      } else {
        const created = await api.createAsset(projectId, {
          name: name.trim(),
          category,
          width: settings?.canvas.width ?? 32,
          height: settings?.canvas.height ?? 32,
        });
        assetId = created.id;
      }
      const version = await api.pickCandidate(projectId, assetId, jobId, candidate.index);
      onSaved(assetId, version.id);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Check className="h-4 w-4" /> {t('generate.save.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="save-target"
              checked={target === 'new'}
              onChange={() => setTarget('new')}
              className="accent-primary"
            />
            {t('generate.save.newAsset')}
          </label>
          <label className={`flex items-center gap-2 text-sm ${activeAsset ? '' : 'opacity-40'}`}>
            <input
              type="radio"
              name="save-target"
              checked={target === 'existing'}
              disabled={!activeAsset}
              onChange={() => setTarget('existing')}
              className="accent-primary"
            />
            {activeAsset
              ? t('generate.save.newVersionOf', { name: activeAsset.name })
              : t('generate.save.noActiveAsset')}
          </label>
        </div>

        {target === 'new' && (
          <>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('generate.save.name')}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('generate.save.namePlaceholder')} className="h-8 text-sm" autoFocus />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('generate.save.category')}</span>
              <select className="h-8 rounded border bg-background px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value as SpriteCategory)}>
                {CATEGORY_GROUPS.map((g) => (
                  <optgroup key={g.id} label={t(g.labelKey)}>
                    {g.categories.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          </>
        )}

        {error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('generate.save.cancel')}</Button>
          <Button size="sm" disabled={busy || !valid} onClick={() => void save()}>
            {busy ? t('generate.save.saving') : t('generate.save.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
