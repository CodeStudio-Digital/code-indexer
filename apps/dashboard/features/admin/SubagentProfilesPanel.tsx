import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SubagentTargetSelect } from './providers/SubagentTargetSelect.js';
import type { AdminModel, AdminProvider } from './types.js';

/**
 * Per-profile subagent model overrides. Each micro-agent profile (implement,
 * explore, verify, review, full) can pin its own provider/model; leaving a row
 * on "use default" inherits the single subagent control above. Collapsed by
 * default — most users only need the default.
 */
const PROFILES: Array<{ id: string; labelKey: string }> = [
  { id: 'implement', labelKey: 'admin:provider.subagentProfiles.implement' },
  { id: 'explore', labelKey: 'admin:provider.subagentProfiles.explore' },
  { id: 'verify', labelKey: 'admin:provider.subagentProfiles.verify' },
  { id: 'review', labelKey: 'admin:provider.subagentProfiles.review' },
  { id: 'full', labelKey: 'admin:provider.subagentProfiles.full' },
];

function readEntry(extra: Record<string, unknown> | undefined, id: string) {
  const profiles = extra?.subagent_profiles;
  const e = profiles && typeof profiles === 'object'
    ? (profiles as Record<string, { provider_id?: string; model?: string; effort?: string }>)[id]
    : undefined;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    providerId: s(e?.provider_id),
    modelId: s(e?.model),
    effort: s(e?.effort),
  };
}

interface SubagentProfilesPanelProps {
  provider: AdminProvider;
  allProviders: AdminProvider[];
  /** The card provider's own models (target === parent). */
  models: AdminModel[];
  providerModelsById: Record<string, AdminModel[]>;
  onLoadProviderModels: (providerId: string) => void | Promise<void>;
  onSetProfileTarget: (
    providerId: string,
    profileId: string,
    subProviderId: string | null,
    modelId: string | null,
  ) => void;
  onSetProfileEffort: (
    providerId: string,
    profileId: string,
    effort: string | null,
  ) => void;
}

export function SubagentProfilesPanel({
  provider: p,
  allProviders,
  models,
  providerModelsById,
  onLoadProviderModels,
  onSetProfileTarget,
  onSetProfileEffort,
}: SubagentProfilesPanelProps) {
  const { t } = useTranslation(['admin']);
  const [open, setOpen] = useState(false);
  const providerOptions = allProviders.filter(
    (c) => c.id !== p.id && c.enabled && c.use_for_coder,
  );
  const overrideCount = PROFILES.filter((prof) => {
    const cur = readEntry(p.extra, prof.id);
    return cur.providerId || cur.modelId;
  }).length;

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {t('admin:provider.subagentProfiles.title')}
        {overrideCount > 0 && (
          <span className="text-xs text-muted-foreground">({overrideCount})</span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('admin:provider.subagentProfiles.subtitle')}
          </p>
          {PROFILES.map((prof) => {
            const cur = readEntry(p.extra, prof.id);
            return (
              <div key={prof.id} className="grid gap-1">
                <span className="text-xs font-semibold">{t(prof.labelKey)}</span>
                <SubagentTargetSelect
                  parentProviderId={p.id}
                  providerId={cur.providerId}
                  modelId={cur.modelId}
                  providerOptions={providerOptions}
                  allProviders={allProviders}
                  baseModels={models}
                  providerModelsById={providerModelsById}
                  onLoadProviderModels={onLoadProviderModels}
                  onChange={(providerId, modelId) =>
                    onSetProfileTarget(p.id, prof.id, providerId, modelId)
                  }
                  effort={cur.effort}
                  onEffortChange={(effort) => onSetProfileEffort(p.id, prof.id, effort)}
                  providerLabel={t('admin:provider.subagentProvider')}
                  modelLabel={t('admin:provider.subagentModel')}
                  effortLabel={t('admin:provider.subagentEffort')}
                  providerEmptyLabel={t('admin:provider.subagentProfiles.useDefault')}
                  modelEmptyLabel={t('admin:provider.subagentProfiles.useDefault')}
                  effortEmptyLabel={t('admin:provider.subagentProfiles.useDefault')}
                  providerAriaLabel={`${prof.id} subagent provider`}
                  modelAriaLabel={`${prof.id} subagent model`}
                  effortAriaLabel={`${prof.id} subagent effort`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
