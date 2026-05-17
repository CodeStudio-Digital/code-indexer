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
import type { KimiCodeFlowState } from './types.js';

interface KimiCodeConnectionDialogProps {
  onClose: () => void;
  onConnected: (providerId?: string) => Promise<void> | void;
}

export function KimiCodeConnectionDialog({ onClose, onConnected }: KimiCodeConnectionDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [flow, setFlow] = useState<KimiCodeFlowState>({ state: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/admin/oauth/kimi-code/start', { method: 'POST' });
        const j = (await r.json()) as {
          verification_url?: string;
          verification_uri?: string;
          verification_uri_complete?: string;
          user_code?: string;
          state?: string;
          interval?: number;
          error?: string;
        };
        const verificationUrl = j.verification_url ?? j.verification_uri;
        if (!verificationUrl || !j.user_code || !j.state) {
          throw new Error(j.error ?? 'unexpected response');
        }
        if (cancelled) return;
        setFlow({
          state: 'waiting',
          verificationUrl,
          verificationUriComplete: j.verification_uri_complete,
          userCode: j.user_code,
          flowState: j.state,
          interval: j.interval ?? 5,
        });
        window.open(j.verification_uri_complete ?? verificationUrl, '_blank', 'noopener,noreferrer');

        const poll = async (intervalSeconds: number) => {
          if (cancelled) return;
          try {
            const p = await fetch('/api/admin/oauth/kimi-code/poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ state: j.state }),
            });
            const pj = (await p.json()) as {
              status: string;
              error?: string;
              provider_id?: string;
              model_count?: number;
              interval?: number;
            };
            if (pj.status === 'authorized') {
              if (cancelled) return;
              setFlow({
                state: 'success',
                providerId: pj.provider_id,
                modelCount: pj.model_count,
              });
              await onConnected(pj.provider_id);
              return;
            }
            if (pj.status === 'expired' || pj.status === 'error') {
              if (!cancelled) setFlow({ state: 'error', message: pj.error ?? 'flow expired' });
              return;
            }
            const nextInterval = pj.interval ?? intervalSeconds;
            setTimeout(() => {
              void poll(nextInterval);
            }, Math.max(1, nextInterval) * 1000);
          } catch (e) {
            if (!cancelled) setFlow({ state: 'error', message: (e as Error).message });
          }
        };
        void poll(j.interval ?? 5);
      } catch (e) {
        if (!cancelled) setFlow({ state: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('admin:kimiCode.title')}</DialogTitle>
        </DialogHeader>
        {flow.state === 'waiting' && (
          <div className="space-y-4 text-sm">
            <p>
              {t('admin:kimiCode.openUrl')}{' '}
              <a
                href={flow.verificationUriComplete ?? flow.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                auth.kimi.com
              </a>{' '}
              {t('admin:kimiCode.enterCode')}
            </p>
            <div className="rounded-md border border-border p-4 text-center">
              <div className="text-xs text-muted-foreground">{t('admin:kimiCode.userCode')}</div>
              <div className="font-mono text-2xl font-semibold tracking-widest">{flow.userCode}</div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('admin:kimiCode.waiting')}
            </div>
          </div>
        )}
        {flow.state === 'success' && (
          <div className="text-sm text-emerald-600">
            {t('admin:kimiCode.connected')}
            {typeof flow.modelCount === 'number' ? t('admin:kimiCode.modelsLoaded', { count: flow.modelCount }) : ''}.
            {' '}{t('admin:kimiCode.available')}
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
