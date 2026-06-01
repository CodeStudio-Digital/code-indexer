/**
 * Builder mode picker + container resources preset for the new-company
 * dialog. Two coupled controls:
 *
 *   - **Builder stack**: `off` (traditional) vs. `react-ts` / `vue-ts` /
 *     `angular` / `vite-api` / `cf-worker`. When ≠ off, the orchestrator
 *     provisions a sandbox container on start and the session opens in
 *     the split-pane builder layout.
 *   - **Container resources**: `default` / `small` / `medium` / `large` /
 *     `custom`. Only relevant when builder is on. `custom` reveals
 *     memory / CPUs / PIDs inputs.
 *
 * Extracted from `NewCompanyDialog.tsx` so the form body stays focused
 * on layout decisions and the two controls can move/test as a unit.
 */

import type { BuilderStack, LimitsPreset } from './types.js';
import { useTranslation } from 'react-i18next';

export interface BuilderModeSectionProps {
  builderStack: BuilderStack;
  setBuilderStack: (stack: BuilderStack) => void;
  limitsPreset: LimitsPreset;
  setLimitsPreset: (preset: LimitsPreset) => void;
  customMemory: string;
  setCustomMemory: (v: string) => void;
  customCpus: string;
  setCustomCpus: (v: string) => void;
  customPids: string;
  setCustomPids: (v: string) => void;
  /** Local OCI image references (from GET /company/sandbox/images). */
  availableImages: string[];
  customImage: string;
  setCustomImage: (v: string) => void;
  customRunArgs: string;
  setCustomRunArgs: (v: string) => void;
}

const STACK_OPTIONS: ReadonlyArray<{ v: BuilderStack; labelKey: string }> = [
  { v: 'off', labelKey: 'builderMode.stack.off' },
  { v: 'react-ts', labelKey: 'builderMode.stack.reactTs' },
  { v: 'vue-ts', labelKey: 'builderMode.stack.vueTs' },
  { v: 'angular', labelKey: 'builderMode.stack.angular' },
  { v: 'vite-api', labelKey: 'builderMode.stack.viteApi' },
  { v: 'cf-worker', labelKey: 'builderMode.stack.cfWorker' },
];

const LIMITS_OPTIONS: ReadonlyArray<{ v: LimitsPreset; labelKey: string; hintKey?: string; hint?: string }> = [
  { v: 'default', labelKey: 'builderMode.limits.default', hintKey: 'builderMode.limits.defaultHint' },
  { v: 'small', labelKey: 'builderMode.limits.small', hint: '512m · 0.5 CPU' },
  { v: 'medium', labelKey: 'builderMode.limits.medium', hint: '1g · 1 CPU' },
  { v: 'large', labelKey: 'builderMode.limits.large', hint: '2g · 2 CPUs' },
  { v: 'custom', labelKey: 'builderMode.limits.custom', hintKey: 'builderMode.limits.fineTune' },
];

export function BuilderModeSection({
  builderStack,
  setBuilderStack,
  limitsPreset,
  setLimitsPreset,
  customMemory,
  setCustomMemory,
  customCpus,
  setCustomCpus,
  customPids,
  setCustomPids,
  availableImages,
  customImage,
  setCustomImage,
  customRunArgs,
  setCustomRunArgs,
}: BuilderModeSectionProps) {
  const { t } = useTranslation('agents');
  return (
    <>
      <div>
        <label className="text-xs font-medium text-muted-foreground">
          {t('builderMode.label')}
        </label>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:flex">
          {STACK_OPTIONS.map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => setBuilderStack(opt.v)}
              className={
                'flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ' +
                (builderStack === opt.v
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background hover:bg-muted')
              }
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
        {builderStack !== 'off' && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t('builderMode.previewHint')}
          </p>
        )}
      </div>

      {builderStack !== 'off' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            {t('builderMode.resources')}
          </label>
          <div className="mt-1 grid grid-cols-5 gap-1.5">
            {LIMITS_OPTIONS.map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setLimitsPreset(opt.v)}
                className={
                  'rounded-md border px-2 py-1.5 text-[11px] leading-tight transition-colors flex flex-col ' +
                  (limitsPreset === opt.v
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background hover:bg-muted')
                }
                title={opt.hintKey ? t(opt.hintKey) : opt.hint}
              >
                <span className="font-medium">{t(opt.labelKey)}</span>
                <span className="opacity-70 text-[9px]">{opt.hintKey ? t(opt.hintKey) : opt.hint}</span>
              </button>
            ))}
          </div>
          {limitsPreset === 'custom' && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground">{t('builderMode.memory')}</label>
                <input
                  value={customMemory}
                  onChange={(e) => setCustomMemory(e.target.value)}
                  placeholder="1g"
                  className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">{t('builderMode.cpus')}</label>
                <input
                  value={customCpus}
                  onChange={(e) => setCustomCpus(e.target.value)}
                  placeholder="1"
                  className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">{t('builderMode.pids')}</label>
                <input
                  value={customPids}
                  onChange={(e) => setCustomPids(e.target.value)}
                  placeholder="256"
                  inputMode="numeric"
                  className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                />
              </div>
            </div>
          )}
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t('builderMode.memoryHelp')} <code className="font-mono">512m</code>,
            {' '}<code className="font-mono">1g</code>{t('builderMode.cpusHelp')}
            (<code className="font-mono">0.5</code>, <code className="font-mono">2</code>).
          </p>

          {/* Base image picker — pulls from the host's local Podman/Docker
              catalog. Empty = the server's default node image. A datalist
              lets the user type any reference even if it isn't pulled yet. */}
          <div className="mt-3">
            <label className="text-xs font-medium text-muted-foreground">{t('builderMode.baseImage')}</label>
            <input
              list="podman-image-catalog"
              value={customImage}
              onChange={(e) => setCustomImage(e.target.value)}
              placeholder={t('builderMode.defaultImagePlaceholder')}
              className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
            />
            <datalist id="podman-image-catalog">
              {availableImages.map((ref) => (
                <option key={ref} value={ref} />
              ))}
            </datalist>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {t('builderMode.customImageHelp')}
            </p>
          </div>

          {/* Extra raw run flags (one per line). Threaded to podman/docker run. */}
          <div className="mt-2">
            <label className="text-xs font-medium text-muted-foreground">{t('builderMode.runtimeFlags')}</label>
            <textarea
              value={customRunArgs}
              onChange={(e) => setCustomRunArgs(e.target.value)}
              placeholder={'--cpuset-cpus=0-3\n--add-host=db:10.0.0.5'}
              rows={2}
              className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
            />
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {t('builderMode.runtimeFlagsHelp')}{' '}
              <code className="font-mono">{'run'}</code>.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
