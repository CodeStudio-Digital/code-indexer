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
}

const STACK_OPTIONS: ReadonlyArray<{ v: BuilderStack; label: string }> = [
  { v: 'off', label: 'Off (traditional)' },
  { v: 'react-ts', label: 'React + Vite' },
  { v: 'vue-ts', label: 'Vue 3 + Vite' },
  { v: 'angular', label: 'Angular 19' },
  { v: 'vite-api', label: 'API — Hono + Vite' },
  { v: 'cf-worker', label: 'API — Cloudflare Worker' },
];

const LIMITS_OPTIONS: ReadonlyArray<{ v: LimitsPreset; label: string; hint: string }> = [
  { v: 'default', label: 'Default', hint: 'Server-configured' },
  { v: 'small', label: 'Small', hint: '512m · 0.5 CPU' },
  { v: 'medium', label: 'Medium', hint: '1g · 1 CPU' },
  { v: 'large', label: 'Large', hint: '2g · 2 CPUs' },
  { v: 'custom', label: 'Custom', hint: 'Fine-tune' },
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
}: BuilderModeSectionProps) {
  return (
    <>
      <div>
        <label className="text-xs font-medium text-muted-foreground">
          Builder mode (live preview)
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
              {opt.label}
            </button>
          ))}
        </div>
        {builderStack !== 'off' && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            A sandbox container will be provisioned on session start. HMR-enabled
            preview appears in a side pane.
          </p>
        )}
      </div>

      {builderStack !== 'off' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Container resources
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
                title={opt.hint}
              >
                <span className="font-medium">{opt.label}</span>
                <span className="opacity-70 text-[9px]">{opt.hint}</span>
              </button>
            ))}
          </div>
          {limitsPreset === 'custom' && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground">Memory</label>
                <input
                  value={customMemory}
                  onChange={(e) => setCustomMemory(e.target.value)}
                  placeholder="1g"
                  className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">CPUs</label>
                <input
                  value={customCpus}
                  onChange={(e) => setCustomCpus(e.target.value)}
                  placeholder="1"
                  className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">PIDs</label>
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
            Memory accepts suffixes like <code className="font-mono">512m</code>,
            {' '}<code className="font-mono">1g</code>. CPUs is fractional
            (<code className="font-mono">0.5</code>, <code className="font-mono">2</code>).
          </p>
        </div>
      )}
    </>
  );
}
