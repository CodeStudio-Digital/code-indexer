import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ShieldQuestion, X } from 'lucide-react';
import type { PendingToolApproval } from '../../../hooks/agent-stream/types.js';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { cn } from '../../../lib/utils.js';

export type ToolApprovalVerdict = { approved: boolean; note?: string; alwaysAllow?: boolean };

interface ToolApprovalCardProps {
  approvals: PendingToolApproval[];
  onRespond: (toolUseId: string, verdict: ToolApprovalVerdict) => Promise<void>;
  /** Compact variant for the banner above the message list. */
  compact?: boolean;
}

const RISK_STYLE: Record<PendingToolApproval['riskClass'], string> = {
  write: 'bg-info/15 text-info',
  execute: 'bg-warning/15 text-warning',
  admin: 'bg-destructive/15 text-destructive',
};

/**
 * Inline approval affordance for a PermissionGate pause — rendered inside
 * the pending tool block (or the banner), NOT as a chat message. One card
 * per request; a code_exec block can stack several.
 */
export function ToolApprovalCard({ approvals, onRespond, compact }: ToolApprovalCardProps) {
  return (
    <div className="space-y-2">
      {approvals.map((a) => (
        <ApprovalRow key={a.toolUseId} approval={a} onRespond={onRespond} compact={compact} />
      ))}
    </div>
  );
}

function ApprovalRow({
  approval,
  onRespond,
  compact,
}: {
  approval: PendingToolApproval;
  onRespond: (toolUseId: string, verdict: ToolApprovalVerdict) => Promise<void>;
  compact?: boolean;
}) {
  const { t } = useTranslation('chat');
  const [note, setNote] = useState('');
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [resolving, setResolving] = useState(false);
  const isDatabaseWrite = approval.approvalKind === 'database_write';

  const respond = async (approved: boolean) => {
    if (resolving) return;
    setResolving(true);
    try {
      await onRespond(approval.toolUseId, {
        approved,
        note: note.trim() || undefined,
        alwaysAllow: approved && alwaysAllow ? true : undefined,
      });
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs">
      <div className="flex items-center gap-2 mb-2">
        <ShieldQuestion className="h-4 w-4 text-warning shrink-0" />
        <span className="font-semibold text-warning uppercase tracking-wider text-[10px]">
          {t('approval.title', { defaultValue: 'Aprovação necessária' })}
        </span>
        <span className="font-mono font-medium text-foreground truncate">{approval.toolName}</span>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0', RISK_STYLE[approval.riskClass])}>
          {t(`approval.risk.${approval.riskClass}`, { defaultValue: approval.riskClass })}
        </span>
        {approval.nested && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
            {t('approval.nested', { defaultValue: 'aninhada' })}
          </span>
        )}
      </div>
      {!compact && approval.argsSummary && (
        <pre className="font-mono text-[11px] bg-card border rounded-md p-2 mb-2 overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
          {approval.argsSummary}
        </pre>
      )}
      {isDatabaseWrite && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-[11px] leading-relaxed text-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>{t('approval.databaseWriteWarning')}</span>
        </div>
      )}
      {!compact && (
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('approval.notePlaceholder', { defaultValue: 'Motivo opcional (enviado ao agente)…' })}
          rows={1}
          className="mb-2 text-xs"
        />
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="success" disabled={resolving} onClick={() => void respond(true)}>
          <Check className="h-3.5 w-3.5" />
          {isDatabaseWrite
            ? t('approval.executeOnce', { defaultValue: 'Executar uma vez' })
            : t('approval.approve', { defaultValue: 'Aprovar' })}
        </Button>
        <Button size="sm" variant="destructive" disabled={resolving} onClick={() => void respond(false)}>
          <X className="h-3.5 w-3.5" /> {t('approval.deny', { defaultValue: 'Negar' })}
        </Button>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
          {isDatabaseWrite
            ? t('approval.alwaysAllowDatabaseWrite')
            : t('approval.alwaysAllow', { defaultValue: 'Sempre permitir esta ferramenta nesta sessão' })}
        </label>
      </div>
    </div>
  );
}
