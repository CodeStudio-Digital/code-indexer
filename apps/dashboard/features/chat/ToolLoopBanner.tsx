/**
 * Banner that surfaces a loop-detection intervention to the user.
 *
 * Rendered for two distinct event families:
 *
 *  1. **Guard interventions** (dup-call cap / doom-loop strict /
 *     doom-loop fuzzy / dominance) — the runner refused or aborted
 *     the call because a loop pattern was detected. Existing render
 *     with snapshot disclosure.
 *
 *  2. **Dup-result-marker REFUSED tier** — the runner hit the
 *     escalation threshold (`matches.length >= _REFUSE`) and replaced
 *     the tool result with a refusal message. Distinct render: amber
 *     strip, `hitCount` + tool + first-seen turn, no snapshot.
 *     Lighter tiers (`'informational'` severity → light / medium
 *     marker) are filtered OUT — they're just content-delivery hints
 *     and shouldn't produce a permanent banner.
 *
 * Severity styling:
 *   - `aborted` → destructive (red). The run is over.
 *   - `refused` → amber. The agent kept going but the call was blocked.
 *
 * The snapshot fields are rendered behind a "Why didn't the others
 * fire?" disclosure so we have first-class debugging without
 * cluttering the default view.
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type {
  ToolLoopIntervention,
  ToolLoopGuardIntervention,
  DupResultMarkerIntervention,
} from '../../hooks/agent-stream/types.js';
import { cn } from '../../lib/utils.js';

interface ToolLoopBannerProps {
  /**
   * May be `undefined` while the hook bootstraps — guard for it so a
   * race during HMR or a future API drift doesn't crash the chat view.
   */
  interventions: readonly ToolLoopIntervention[] | undefined;
}

const KIND_LABELS: Record<ToolLoopGuardIntervention['kind'], string> = {
  'dup-call-cap': 'Repeated identical call',
  'doom-loop-strict': 'Doom loop (strict)',
  'doom-loop-fuzzy': 'Doom loop (fuzzy)',
  dominance: 'Tool dominance',
};

type DupRefusedIntervention = DupResultMarkerIntervention & {
  receivedAt: number;
  severity: 'refused';
};

/** Render gate: keep all guard variants + dup-result-marker REFUSED. */
function shouldRenderInBanner(iv: ToolLoopIntervention): boolean {
  if (iv.kind === 'dup-result-marker') return iv.severity === 'refused';
  return true;
}

export function ToolLoopBanner({ interventions }: ToolLoopBannerProps) {
  if (!interventions || interventions.length === 0) return null;
  // Drop informational variants (light/medium dup markers) — they're
  // content hints, not failures. Filter after the early-return so an
  // all-informational list collapses to nothing instead of an empty
  // strip.
  const visible = interventions.filter(shouldRenderInBanner);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 bg-muted/30 px-3 py-2">
      {visible.map((iv, idx) => {
        if (iv.kind === 'dup-result-marker') {
          return (
            <DupRefusedRow
              key={`dup-${iv.currentTurn}-${idx}`}
              intervention={iv as DupRefusedIntervention}
            />
          );
        }
        return (
          <ToolLoopRow
            key={`${iv.turn}-${iv.kind}-${idx}`}
            intervention={iv}
          />
        );
      })}
    </div>
  );
}

function ToolLoopRow({
  intervention: iv,
}: {
  intervention: ToolLoopGuardIntervention & { receivedAt: number };
}) {
  const [open, setOpen] = useState(false);
  const aborted = iv.severity === 'aborted';
  const Icon = aborted ? AlertTriangle : RotateCcw;
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-1.5 text-xs',
        aborted
          ? 'border-destructive/40 bg-destructive/[0.06] text-destructive'
          : 'border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{KIND_LABELS[iv.kind]}</span>
            <span className="text-[10px] opacity-70">turn {iv.turn}</span>
            <span className="text-[10px] opacity-70">
              {iv.count}/{iv.threshold} in {iv.window}-turn window
            </span>
            <span className="ml-auto text-[10px] uppercase opacity-70">
              {iv.severity}
            </span>
          </div>
          <p className="mt-0.5 leading-snug">{iv.reason}</p>
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 text-[10px] opacity-70 hover:opacity-100"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Snapshot (why didn't the other guards fire?)
          </button>
          {open && (
            <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1.5 font-mono text-[10px] leading-snug">
              {`strict: ${JSON.stringify(iv.snapshot.strict)}\n`}
              {`fuzzy:  ${JSON.stringify(iv.snapshot.fuzzy)}\n`}
              {`dominance: ${JSON.stringify(iv.snapshot.dominance)}`}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Row variant for the dup-result-marker REFUSED tier. No snapshot /
 * threshold to render — the relevant info is `hitCount`, `toolName`,
 * and the original turn where the duplicate content was first seen.
 * Pairs with `buildDupRefusalText` server-side; copy here is short
 * because the full refusal is already embedded in the tool result the
 * agent sees.
 */
function DupRefusedRow({ intervention: iv }: { intervention: DupRefusedIntervention }) {
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-1.5 text-xs',
        'border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300',
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">Identical fetch refused</span>
            <span className="text-[10px] opacity-70">turn {iv.currentTurn}</span>
            <span className="text-[10px] opacity-70">
              {iv.hitCount}× identical since turn {iv.originalTurn}
            </span>
            <span className="ml-auto text-[10px] uppercase opacity-70">refused</span>
          </div>
          <p className="mt-0.5 leading-snug">
            <span className="font-mono">{iv.toolName}</span> returned the same content for
            the {iv.hitCount}th time in a row. The agent should act on the data it already
            has, or pass <span className="font-mono">force_reread: true</span> if the
            source genuinely changed.
          </p>
        </div>
      </div>
    </div>
  );
}
