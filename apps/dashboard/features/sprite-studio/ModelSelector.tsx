/**
 * In-studio image-model picker (header). Lets the user switch the active image
 * generator on the fly — no trip to admin → Pipelines. Single-active: picking a
 * model makes it THE `sprite-studio/image_gen` binding. Failover chains stay an
 * admin concern.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { getActiveImageModel, listImageModels, setActiveImageModel, type ImageModelOption } from './api.js';

export function ModelSelector() {
  const { t } = useTranslation('spriteStudio');
  const [models, setModels] = useState<ImageModelOption[]>([]);
  const [active, setActive] = useState<{ providerId: string; modelId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [list, current] = await Promise.all([
        listImageModels().catch(() => []),
        getActiveImageModel().catch(() => null),
      ]);
      if (!alive) return;
      setModels(list);
      setActive(current ? { providerId: current.providerId, modelId: current.modelId } : null);
    })();
    return () => { alive = false; };
  }, []);

  const pick = async (m: ImageModelOption) => {
    setBusy(true);
    try {
      await setActiveImageModel(m.providerId, m.modelId);
      setActive({ providerId: m.providerId, modelId: m.modelId });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeLabel = active
    ? models.find((m) => m.providerId === active.providerId && m.modelId === active.modelId)?.label
      ?? active.modelId
    : t('model.none');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-6 max-w-[260px] gap-1 border-[var(--workbench-border)] bg-[var(--workbench-surface)] px-2" title={t('model.tooltip')}>
          {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Cpu className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{activeLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuLabel>{t('model.pickLabel')}</DropdownMenuLabel>
        {models.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('model.empty')}</div>
        )}
        {models.map((m) => {
          const isActive = active?.providerId === m.providerId && active?.modelId === m.modelId;
          // Cost visibility: premium tiers (≥ $0.10/img) get the warning tint
          // so nobody burns a 4-variant batch on them by accident. The estimate
          // is an approximation and may be absent (older backend) — a missing
          // cost hint must never take down the picker, so guard the render.
          const est = m.estUsdPerImage;
          const price = typeof est === 'number' && Number.isFinite(est) ? `~$${est.toFixed(3)}/img` : null;
          const pricey = typeof est === 'number' && est >= 0.1;
          return (
            <DropdownMenuItem
              key={`${m.providerId}:${m.modelId}`}
              onClick={() => void pick(m)}
              className={`justify-between gap-2 ${isActive ? 'font-medium text-primary' : ''}`}
            >
              <span className="truncate">{m.label}</span>
              {price && (
                <span className={`shrink-0 text-[10px] tabular-nums ${pricey ? 'text-amber-400' : 'text-muted-foreground'}`}>
                  {price}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
