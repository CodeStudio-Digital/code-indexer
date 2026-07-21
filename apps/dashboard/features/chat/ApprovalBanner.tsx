/**
 * Banner surfaced while ≥1 PermissionGate approval is pending — the run is
 * paused waiting for the user's verdict. The primary affordance lives on
 * the tool block itself (ToolApprovalCard); this strip exists so the pause
 * is visible even when the block scrolled out of view. Expanded, it renders
 * the same full approval card (including complete SQL) instead of unsafe
 * one-line quick actions. Replaces the StuckBanner while pending
 * (a paused gate is silence by design, not a stall).
 */
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ShieldQuestion } from 'lucide-react';
import type { PendingToolApproval } from '../../hooks/agent-stream/types.js';
import { ToolApprovalCard, type ToolApprovalVerdict } from './messages/ToolApprovalCard.js';

interface ApprovalBannerProps {
  approvals: PendingToolApproval[];
  onRespond: (toolUseId: string, verdict: ToolApprovalVerdict) => Promise<void>;
}

export const ApprovalBanner = memo(function ApprovalBanner({ approvals, onRespond }: ApprovalBannerProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  if (approvals.length === 0) return null;

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
        <div className="mt-2 text-foreground">
          <ToolApprovalCard approvals={approvals} onRespond={onRespond} />
        </div>
      )}
    </div>
  );
});
