/**
 * Inspector card: the active asset's metadata — name, category, tags and
 * status. Text fields commit on blur/Enter (patch-in-place via patchAsset,
 * no full refetch); selects commit on change.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { CATEGORY_GROUPS, type SpriteAsset, type SpriteAssetStatus, type SpriteCategory } from '../types.js';
import { InspectorSection } from './InspectorSection.js';

const STATUSES: SpriteAssetStatus[] = ['draft', 'approved', 'archived', 'missing'];

export function AssetMetaCard({
  asset,
  onPatch,
  onDelete,
}: {
  asset: SpriteAsset;
  onPatch: (assetId: string, patch: Partial<SpriteAsset>) => Promise<void>;
  /** Absent → the danger-delete affordance is hidden. */
  onDelete?: (assetId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('spriteStudio');
  const [name, setName] = useState(asset.name);
  const [tags, setTags] = useState(asset.tags.join(', '));

  // Re-key the local echoes when the selection changes.
  useEffect(() => {
    setName(asset.name);
    setTags(asset.tags.join(', '));
  }, [asset.id, asset.name, asset.tags]);

  const commitName = () => {
    const v = name.trim();
    if (v && v !== asset.name) void onPatch(asset.id, { name: v });
    else setName(asset.name);
  };

  const commitTags = () => {
    const parsed = tags.split(',').map((s) => s.trim()).filter(Boolean);
    if (parsed.join('\n') !== asset.tags.join('\n')) void onPatch(asset.id, { tags: parsed });
  };

  const onEnterBlur = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  };

  return (
    <InspectorSection id="assetMeta" icon={Info} title={t('inspector.meta')}>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('inspector.name')}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={onEnterBlur} className="h-7 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('inspector.category')}</span>
        <select
          className="h-7 rounded border bg-background px-2 text-xs"
          value={asset.category}
          onChange={(e) => void onPatch(asset.id, { category: e.target.value as SpriteCategory })}
        >
          {CATEGORY_GROUPS.map((g) => (
            <optgroup key={g.id} label={t(g.labelKey)}>
              {g.categories.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('inspector.tags')}</span>
        <Input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={commitTags} onKeyDown={onEnterBlur} placeholder={t('inspector.tagsPlaceholder')} className="h-7 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('inspector.status')}</span>
        <select
          className="h-7 rounded border bg-background px-2 text-xs"
          value={asset.status}
          onChange={(e) => void onPatch(asset.id, { status: e.target.value as SpriteAssetStatus })}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{`${asset.slug} · ${asset.width}x${asset.height}`}</span>
        {onDelete && (
          <Button
            size="sm" variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px] text-red-400 hover:bg-red-500/15 hover:text-red-400"
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: t('inspector.deleteAssetTitle'),
                  description: t('inspector.deleteAssetBody', { name: asset.name }),
                  confirmLabel: t('inspector.deleteConfirm'),
                  tone: 'destructive',
                });
                if (ok) await onDelete(asset.id);
              })();
            }}
          >
            <Trash2 className="h-3 w-3" /> {t('inspector.deleteAsset')}
          </Button>
        )}
      </div>
    </InspectorSection>
  );
}
