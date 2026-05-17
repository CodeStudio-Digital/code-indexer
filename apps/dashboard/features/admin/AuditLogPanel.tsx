import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
import { fetchAuditLog, type AuditEventRow } from './auth-api.js';

const STATUS_VARIANT: Record<string, 'default' | 'destructive' | 'outline' | 'secondary'> = {
  auth_ok: 'secondary',
  auth_fail: 'destructive',
  scope_denied: 'destructive',
  rate_limited: 'destructive',
  tool_call_ok: 'default',
  tool_call_error: 'destructive',
  token_issued: 'secondary',
  token_revoked: 'outline',
  client_registered: 'secondary',
  client_revoked: 'outline',
  code_exchanged: 'secondary',
  refresh_rotated: 'secondary',
};

export function AuditLogPanel() {
  const { t } = useTranslation('admin');
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [principal, setPrincipal] = useState('');
  const [event, setEvent] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setEvents(await fetchAuditLog({
        principal: principal || undefined,
        event: event || undefined,
        limit: 200,
      }));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []); // initial

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t('auth.auditLog.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('auth.auditLog.description')}</p>
      </div>

      <div className="flex gap-2 items-end">
        <div>
          <label className="text-xs font-medium block">{t('auth.auditLog.principal')}</label>
          <Input value={principal} onChange={(e) => setPrincipal(e.target.value)} className="w-56" />
        </div>
        <div>
          <label className="text-xs font-medium block">{t('auth.auditLog.event')}</label>
          <Input value={event} onChange={(e) => setEvent(e.target.value)} className="w-56" />
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={'h-4 w-4 mr-2 ' + (loading ? 'animate-spin' : '')} />
          {t('auth.auditLog.refresh')}
        </Button>
      </div>

      <div className="rounded border divide-y max-h-[600px] overflow-auto">
        {events.length === 0 && !loading && (
          <div className="p-4 text-sm text-muted-foreground">{t('auth.auditLog.empty')}</div>
        )}
        {events.map((e, i) => (
          <div key={i} className="p-3 text-xs grid grid-cols-[150px_1fr_100px] gap-3 items-center">
            <span className="text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[e.event] ?? 'outline'}>{e.event}</Badge>
                {e.toolName && <code className="text-[10px]">{e.toolName}</code>}
                {e.principal && <code className="text-[10px] text-muted-foreground truncate">{e.principal}</code>}
              </div>
              {Object.keys(e.meta).length > 0 && (
                <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                  {JSON.stringify(e.meta)}
                </div>
              )}
            </div>
            <span className="text-right font-mono">{e.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
