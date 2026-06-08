import { Check, AlertTriangle, XCircle, CircleHelp, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PreflightCheck } from '@mcp/api-bus';
import { Button } from '../../components/ui/button.js';

const ICON: Record<PreflightCheck['status'], LucideIcon> = {
  ok: Check,
  warn: AlertTriangle,
  missing: XCircle,
  error: XCircle,
};

const TONE: Record<PreflightCheck['status'], string> = {
  ok: 'text-emerald-500',
  warn: 'text-amber-500',
  missing: 'text-destructive',
  error: 'text-destructive',
};

interface Props {
  check: PreflightCheck;
  onAction?: (remediation: string) => void;
  busy?: boolean;
}

export function CheckRow({ check, onAction, busy }: Props) {
  const { t } = useTranslation();
  const Icon = ICON[check.status] ?? CircleHelp;
  return (
    <div className="flex items-start gap-3 p-3 rounded border bg-card/40">
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${TONE[check.status]}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t(`preflight.check.${check.id}`, check.label)}</div>
        <div className="text-[12px] text-muted-foreground break-words">{check.message}</div>
      </div>
      {check.remediation && onAction && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          className="shrink-0"
          onClick={() => onAction(check.remediation!)}
        >
          {t(`preflight.action.${check.remediation}`, t('preflight.action.default'))}
        </Button>
      )}
    </div>
  );
}
