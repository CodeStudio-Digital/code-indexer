/**
 * Banner that surfaces a loop-detection intervention to the user.
 *
 * One of the four guards in `runner.ts` (dup-call cap, strict /
 * fuzzy doom-loop, dominance) just fired — the user could see only
 * "tokens going up" before; now the dashboard renders a coloured
 * strip explaining what was detected. Multiple interventions stack
 * (newest first, capped at 5 by the SessionState reducer).
 *
 * Severity styling:
 *   - `aborted` → destructive (red). The run is over.
 *   - `refused` → amber. The agent kept going but the call was blocked;
 *     the agent received a synthetic tool_result telling it to change
 *     strategy. May still loop.
 *
 * The snapshot fields are rendered behind a "Why didn't the others
 * fire?" disclosure so we have first-class debugging without
 * cluttering the default view.
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type { ToolLoopIntervention } from '../../hooks/agent-stream/types.js';
import { cn } from '../../lib/utils.js';

interface ToolLoopBannerProps {
  interventions: readonly ToolLoopIntervention[];
}

const KIND_LABELS: Record<ToolLoopIntervention['kind'], string> = {
  'dup-call-cap': 'Repeated identical call',
  'doom-loop-strict': 'Doom loop (strict)',
  'doom-loop-fuzzy': 'Doom loop (fuzzy)',
  dominance: 'Tool dominance',
};

export function ToolLoopBanner({ interventions }: ToolLoopBannerProps) {
  if (interventions.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 bg-muted/30 px-3 py-2">
      {interventions.map((iv, idx) => (
        <ToolLoopRow key={`${iv.turn}-${iv.kind}-${idx}`} intervention={iv} />
      ))}
    </div>
  );
}

function ToolLoopRow({ intervention: iv }: { intervention: ToolLoopIntervention }) {
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
