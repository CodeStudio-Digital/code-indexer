/**
 * Banner surfaced while ≥1 PermissionGate approval is pending — the run is
 * paused waiting for the user's verdict. The primary affordance lives on
 * the tool block itself (ToolApprovalCard); this strip exists so the pause
 * is visible even when the block scrolled out of view, and offers inline
 * Approve/Deny as a fallback. Replaces the StuckBanner while pending
 * (a paused gate is silence by design, not a stall).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, ShieldQuestion, X } from 'lucide-react';
import type { PendingToolApproval } from '../../hooks/agent-stream/types.js';
import type { ToolApprovalVerdict } from './messages/ToolApprovalCard.js';

interface ApprovalBannerProps {
  approvals: PendingToolApproval[];
  onRespond: (toolUseId: string, verdict: ToolApprovalVerdict) => Promise<void>;
}

export function ApprovalBanner({ approvals, onRespond }: ApprovalBannerProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  if (approvals.length === 0) return null;

  const respond = async (toolUseId: string, approved: boolean) => {
    if (resolving) return;
    setResolving(toolUseId);
    try {
      await onRespond(toolUseId, { approved });
    } finally {
      setResolving(null);
    }
  };

  return (
    <div className="border-b border-warning/40 bg-warning/[0.06] px-3 py-2 text-xs text-warning">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ShieldQuestion className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 font-medium">
          {t('approval.pendingCount', {
            count: approvals.length,
            defaultValue: '{{count}} aprovação(ões) pendente(s) — o agente está pausado aguardando você',
          })}
        </span>
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {approvals.map((a) => (
            <div key={a.toolUseId} className="flex items-center gap-2 rounded border border-warning/30 bg-background/60 px-2 py-1.5">
              <span className="font-mono font-medium text-foreground truncate">{a.toolName}</span>
              <span className="flex-1 truncate font-mono text-[10px] text-muted-foreground">{a.argsSummary}</span>
              <button
                type="button"
                disabled={resolving !== null}
                onClick={() => void respond(a.toolUseId, true)}
                className="inline-flex items-center gap-1 rounded border border-success/40 px-2 py-0.5 text-[10px] font-medium text-success hover:bg-success/[0.12] disabled:opacity-50"
              >
                <Check className="h-3 w-3" />
                {t('approval.approve', { defaultValue: 'Aprovar' })}
              </button>
              <button
                type="button"
                disabled={resolving !== null}
                onClick={() => void respond(a.toolUseId, false)}
                className="inline-flex items-center gap-1 rounded border border-destructive/40 px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/[0.12] disabled:opacity-50"
              >
                <X className="h-3 w-3" />
                {t('approval.deny', { defaultValue: 'Negar' })}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
