import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { openClaudeCodeAuthorization } from './claude-code-authorization.js';
import type { ClaudeCodeFlowState } from './types.js';

interface ClaudeCodeConnectionDialogProps {
  providerId?: string;
  onClose: () => void;
  onConnected: (providerId?: string) => Promise<void> | void;
}

function openClaudeAuthorization(
  authorizeUrl: string,
  manualAuthorizeUrl: string | undefined,
  mode: 'automatic' | 'manual',
): void {
  openClaudeCodeAuthorization(
    { authorizeUrl, manualAuthorizeUrl },
    mode,
    {
      openExternal: window.electronAPI?.openExternal,
      openWindow: (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
  );
}

export function ClaudeCodeConnectionDialog({
  providerId,
  onClose,
  onConnected,
}: ClaudeCodeConnectionDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [flow, setFlow] = useState<ClaudeCodeFlowState>({ state: 'idle' });
  const [manualCode, setManualCode] = useState('');
  const [manualSubmitting, setManualSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/admin/oauth/claude-code/start', { method: 'POST' });
        const j = (await r.json()) as {
          authorize_url?: string;
          manual_authorize_url?: string;
          state?: string;
          error?: string;
        };
        if (!j.authorize_url || !j.state) throw new Error(j.error ?? 'unexpected response');
        if (cancelled) return;
        setFlow({
          state: 'waiting',
          authorizeUrl: j.authorize_url,
          manualAuthorizeUrl: j.manual_authorize_url,
          flowState: j.state,
        });
        openClaudeAuthorization(j.authorize_url, j.manual_authorize_url, 'automatic');
        const poll = async () => {
          if (cancelled) return;
          try {
            const p = await fetch('/api/admin/oauth/claude-code/poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ state: j.state, provider_id: providerId }),
            });
            const pj = (await p.json()) as {
              status: string;
              error?: string;
              provider_id?: string;
              model_count?: number;
              auth_type?: string;
            };
            if (pj.status === 'authorized') {
              if (cancelled) return;
              setFlow({
                state: 'success',
                providerId: pj.provider_id,
                modelCount: pj.model_count,
                authType: pj.auth_type,
              });
              await onConnected(pj.provider_id);
              return;
            }
            if (pj.status === 'expired' || pj.status === 'error') {
              if (!cancelled) setFlow({ state: 'error', message: pj.error ?? 'flow expired' });
              return;
            }
            setTimeout(() => {
              void poll();
            }, 2000);
          } catch (e) {
            if (!cancelled) setFlow({ state: 'error', message: (e as Error).message });
          }
        };
        void poll();
      } catch (e) {
        if (!cancelled) setFlow({ state: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const submitManualCode = async () => {
    if (flow.state !== 'waiting' || !manualCode.trim()) return;
    setManualSubmitting(true);
    try {
      const r = await fetch('/api/admin/oauth/claude-code/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: flow.flowState, code: manualCode.trim() }),
      });
      const j = (await r.json()) as { status?: string; error?: string };
      if (!r.ok || j.status !== 'ok') {
        throw new Error(j.error ?? 'manual code failed');
      }
      setManualCode('');
    } catch (e) {
      setFlow({ state: 'error', message: (e as Error).message });
    } finally {
      setManualSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('admin:claudeCode.title')}</DialogTitle>
        </DialogHeader>
        {flow.state === 'waiting' && (
          <div className="space-y-3 text-sm">
            <p>
              {t('admin:claudeCode.loginStep')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('admin:claudeCode.authorizeStep')}
            </p>
            <Button
              type="button"
              className="w-full"
              onClick={() => openClaudeAuthorization(
                flow.authorizeUrl,
                flow.manualAuthorizeUrl,
                'automatic',
              )}
            >
              {t('admin:claudeCode.openAuthorization')}
            </Button>
            {flow.manualAuthorizeUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => openClaudeAuthorization(
                  flow.authorizeUrl,
                  flow.manualAuthorizeUrl,
                  'manual',
                )}
              >
                {t('admin:claudeCode.openManualAuthorization')}
              </Button>
            )}
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">
                {t('admin:claudeCode.manualHint')}
              </p>
              <div className="flex gap-2">
                <Input
                  value={manualCode}
                  onChange={(event) => setManualCode(event.target.value)}
                  placeholder={t('admin:claudeCode.manualPlaceholder')}
                  className="h-8 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void submitManualCode()}
                  disabled={manualSubmitting || !manualCode.trim()}
                >
                  {manualSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : t('admin:claudeCode.submitCode')}
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('admin:claudeCode.waiting')}
            </div>
          </div>
        )}
        {flow.state === 'success' && (
          <div className="text-sm text-emerald-600">
            {t('admin:claudeCode.connected')}
            {typeof flow.modelCount === 'number' ? t('admin:claudeCode.modelsLoaded', { count: flow.modelCount }) : ''}.
            {' '}{t('admin:claudeCode.available')}
          </div>
        )}
        {flow.state === 'error' && <div className="text-sm text-red-600 break-all">{flow.message}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
