/**
 * Inner bodies for tool-loop / failure-streak interventions, surfaced inside
 * the shared `NotificationRow` chrome. Ported verbatim from the old
 * `ToolLoopBanner` rows so the visuals (labels, copy, snapshot disclosure)
 * stay identical — only the outer border/colour now comes from the chrome,
 * which colours by `notification.severity` (info=blue, warning=amber,
 * error=red), exactly the mapping the old rows hard-coded per kind.
 *
 * Bodies are colour-agnostic: they use `opacity-*` and `text-current`, so they
 * inherit whatever colour the chrome sets.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type {
  ToolLoopIntervention,
  ToolLoopGuardIntervention,
  FailureStreakIntervention,
} from '../../../hooks/agent-stream/types.js';

const KIND_LABELS: Record<ToolLoopGuardIntervention['kind'], string> = {
  'doom-loop-strict': 'Doom loop (strict)',
  'doom-loop-fuzzy': 'Doom loop (fuzzy)',
  dominance: 'Tool dominance',
};

/** Render the inner content for any tool-loop intervention kind. */
export function LoopBody({ intervention: iv }: { intervention: ToolLoopIntervention }) {
  switch (iv.kind) {
    case 'failure-streak':
      return <FailureStreakBody intervention={iv} />;
    default:
      return <GuardBody intervention={iv} />;
  }
}

function GuardBody({ intervention: iv }: { intervention: ToolLoopGuardIntervention }) {
  const [open, setOpen] = useState(false);
  const snapshot = iv.snapshot;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold">{KIND_LABELS[iv.kind]}</span>
        <span className="text-[10px] opacity-70">turn {iv.turn}</span>
        <span className="text-[10px] opacity-70">
          {iv.count}/{iv.threshold} in {iv.window}-turn window
        </span>
        <span className="ml-auto text-[10px] uppercase opacity-70">{iv.severity}</span>
      </div>
      <p className="mt-0.5 leading-snug">{iv.reason}</p>
      {snapshot && (
        <>
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
              {`strict: ${JSON.stringify(snapshot.strict)}\n`}
              {`fuzzy:  ${JSON.stringify(snapshot.fuzzy)}\n`}
              {`dominance: ${JSON.stringify(snapshot.dominance)}`}
            </pre>
          )}
        </>
      )}
    </>
  );
}

function FailureStreakBody({ intervention: iv }: { intervention: FailureStreakIntervention }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold">Tool failure streak</span>
        <span className="text-[10px] opacity-70">turn {iv.turn}</span>
        <span className="text-[10px] opacity-70">
          {iv.count}× failed since turn {iv.firstFailureTurn}
        </span>
        <span className="ml-auto text-[10px] uppercase opacity-70">{iv.severity}</span>
      </div>
      <p className="mt-0.5 leading-snug">
        <span className="font-mono">{iv.toolName}</span> {iv.reason}
      </p>
      {iv.lastError && (
        <p className="mt-1 rounded bg-background/60 p-1.5 font-mono text-[10px] leading-snug text-current/80">
          {iv.lastError}
        </p>
      )}
    </>
  );
}
