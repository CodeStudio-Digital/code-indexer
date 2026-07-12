import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Boxes, Brain, Code2, Database, Gauge, Layers3, Monitor, Palette, ShieldCheck, Workflow } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Combobox, type ComboboxOption } from '../../components/ui/combobox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { useProviders } from '../../hooks/useProviders.js';
import type { EnrichedProviderModel } from '../chat/types.js';
import { providerSupportsThinking, resolveReasoningLevels } from '../chat/composer/provider-caps.js';

export type AppStudioSpecialistKind = 'spec' | 'product' | 'db' | 'architecture' | 'ux' | 'wireframe' | 'design' | 'backend' | 'review';

const STORAGE_KEYS: Record<AppStudioSpecialistKind, string> = {
  spec: 'mcp.app-studio.spec-agent-config',
  product: 'mcp.app-studio.product-agent-config',
  db: 'mcp.app-studio.db-agent-config',
  architecture: 'mcp.app-studio.architecture-agent-config',
  ux: 'mcp.app-studio.ux-agent-config',
  wireframe: 'mcp.app-studio.wireframe-agent-config',
  design: 'mcp.app-studio.design-agent-config',
  backend: 'mcp.app-studio.backend-agent-config',
  review: 'mcp.app-studio.review-agent-config',
};

export interface AppStudioSpecAgentConfig {
  provider: string;
  model: string;
  thinking: boolean;
  reasoningEffort: string | null;
}

interface StoredConfig {
  provider?: string;
  model?: string;
  thinking?: boolean;
  reasoningEffort?: string | null;
}

interface AppStudioSpecAgentLauncherProps {
  open: boolean;
  kind?: AppStudioSpecialistKind;
  onOpenChange: (open: boolean) => void;
  onLaunch: (config: AppStudioSpecAgentConfig) => void;
}

function readStoredConfig(kind: AppStudioSpecialistKind): StoredConfig | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS[kind]);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredConfig(kind: AppStudioSpecialistKind, config: AppStudioSpecAgentConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEYS[kind], JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

function modelValue(model: EnrichedProviderModel): string {
  return model.mode ? `${model.id}::${model.mode}` : model.id;
}

function modelOptions(models: EnrichedProviderModel[]): ComboboxOption[] {
  return models.map((m) => ({
    value: modelValue(m),
    label: m.name || m.id,
    hint: m.mode,
  }));
}

export function AppStudioSpecAgentLauncher({
  open,
  kind = 'spec',
  onOpenChange,
  onLaunch,
}: AppStudioSpecAgentLauncherProps) {
  const { t } = useTranslation('appStudio');
  const { providerOptions, loading } = useProviders();
  const initializedRef = useRef(false);
  const providerKey = providerOptions.map((p) => p.id).join('|');

  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState('');
  const scope = kind === 'db'
    ? 'dbLaunch'
    : kind === 'product'
      ? 'productLaunch'
    : kind === 'architecture'
      ? 'architectureLaunch'
      : kind === 'design'
        ? 'designLaunch'
        : kind === 'ux'
          ? 'uxLaunch'
          : kind === 'wireframe'
            ? 'wireframeLaunch'
        : kind === 'backend'
          ? 'backendLaunch'
          : kind === 'review'
            ? 'reviewLaunch'
            : 'specLaunch';
  const Icon = kind === 'db'
    ? Database
    : kind === 'product'
      ? Layers3
    : kind === 'architecture'
      ? Boxes
      : kind === 'design'
        ? Monitor
        : kind === 'ux'
          ? Palette
          : kind === 'wireframe'
            ? Workflow
        : kind === 'backend'
          ? Code2
          : kind === 'review'
            ? ShieldCheck
            : Bot;

  const models = useMemo(
    () => providerOptions.find((p) => p.id === provider)?.models ?? [],
    [providerOptions, provider],
  );
  const reasoningLevels = useMemo(
    () => resolveReasoningLevels(provider, providerOptions, model),
    [provider, providerOptions, model],
  );
  const supportsThinking = providerSupportsThinking(provider, providerOptions, model);

  useEffect(() => {
    if (!open) {
      initializedRef.current = false;
      return;
    }
    if (initializedRef.current || loading || providerOptions.length === 0) return;
    initializedRef.current = true;

    const stored = readStoredConfig(kind);
    const storedProviderOk = stored?.provider && providerOptions.some((p) => p.id === stored.provider);
    const nextProvider = storedProviderOk ? stored.provider! : providerOptions[0].id;
    const nextModels = providerOptions.find((p) => p.id === nextProvider)?.models ?? [];
    const storedModelOk =
      !!stored?.model &&
      (nextModels.length === 0 || nextModels.some((m) => modelValue(m) === stored.model || m.id === stored.model));
    const nextModel = storedModelOk ? stored!.model! : nextModels[0] ? modelValue(nextModels[0]) : '';

    setProvider(nextProvider);
    setModel(nextModel);
    setThinking(stored?.thinking === true);
    setReasoningEffort(typeof stored?.reasoningEffort === 'string' ? stored.reasoningEffort : '');
  }, [open, kind, loading, providerKey, providerOptions]);

  useEffect(() => {
    if (!supportsThinking && thinking) setThinking(false);
  }, [supportsThinking, thinking]);

  useEffect(() => {
    if (reasoningEffort && !reasoningLevels.includes(reasoningEffort)) {
      setReasoningEffort('');
    }
  }, [reasoningLevels, reasoningEffort]);

  const selectProvider = (nextProvider: string) => {
    const nextModels = providerOptions.find((p) => p.id === nextProvider)?.models ?? [];
    setProvider(nextProvider);
    setModel(nextModels[0] ? modelValue(nextModels[0]) : '');
    setReasoningEffort('');
    setThinking(false);
  };

  const launch = () => {
    if (!provider || !model) return;
    const config: AppStudioSpecAgentConfig = {
      provider,
      model,
      thinking: supportsThinking ? thinking : false,
      reasoningEffort: reasoningEffort || null,
    };
    writeStoredConfig(kind, config);
    onLaunch(config);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-primary" />
            {t(`chatRail.${scope}.title`)}
          </DialogTitle>
          <DialogDescription>{t(`chatRail.${scope}.description`)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t(`chatRail.${scope}.provider`)}</label>
            <Combobox
              value={provider}
              onChange={selectProvider}
              options={providerOptions.map((p) => ({ value: p.id, label: p.label }))}
              disabled={loading || providerOptions.length === 0}
              placeholder={t(`chatRail.${scope}.provider`)}
              searchPlaceholder={t(`chatRail.${scope}.searchProvider`)}
              emptyLabel={t(`chatRail.${scope}.noProviders`)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t(`chatRail.${scope}.model`)}</label>
            {models.length > 0 ? (
              <Combobox
                value={model}
                onChange={setModel}
                options={modelOptions(models)}
                disabled={!provider}
                placeholder={t(`chatRail.${scope}.model`)}
                searchPlaceholder={t(`chatRail.${scope}.searchModel`)}
                emptyLabel={t(`chatRail.${scope}.noModels`)}
              />
            ) : (
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!provider}
                className="h-8 text-xs font-mono"
                placeholder={t(`chatRail.${scope}.modelPlaceholder`)}
              />
            )}
          </div>

          {reasoningLevels.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t(`chatRail.${scope}.effort`)}</label>
              <div className="flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <select
                  className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value)}
                >
                  <option value="">{t(`chatRail.${scope}.effortAuto`)}</option>
                  {reasoningLevels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {supportsThinking && (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Brain className="h-3.5 w-3.5 text-primary" />
                  {t(`chatRail.${scope}.thinking`)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t(`chatRail.${scope}.thinkingHint`)}</p>
              </div>
              <Switch checked={thinking} onCheckedChange={setThinking} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('pipeline.cancel')}
          </Button>
          <Button size="sm" onClick={launch} disabled={!provider || !model}>
            <Icon className="mr-1 h-3.5 w-3.5" />
            {t(`chatRail.${scope}.launch`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
