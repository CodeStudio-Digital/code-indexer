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
import type { GoogleFlowState } from './types.js';

interface GoogleConnectionDialogProps {
  onClose: () => void;
  onConnected: (providerId?: string) => Promise<void> | void;
}

export function GoogleConnectionDialog({ onClose, onConnected }: GoogleConnectionDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [flow, setFlow] = useState<GoogleFlowState>({ state: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/admin/oauth/google/start', { method: 'POST' });
        const j = (await r.json()) as { authorize_url?: string; state?: string; error?: string };
        if (!j.authorize_url || !j.state) throw new Error(j.error ?? 'unexpected response');
        if (cancelled) return;
        setFlow({ state: 'waiting', authorizeUrl: j.authorize_url, flowState: j.state });
        window.open(j.authorize_url, '_blank', 'noopener,noreferrer');
        const poll = async () => {
          if (cancelled) return;
          try {
            const p = await fetch('/api/admin/oauth/google/poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ state: j.state }),
            });
            const pj = (await p.json()) as {
              status: string;
              error?: string;
              provider_id?: string;
              model_count?: number;
            };
            if (pj.status === 'authorized') {
              if (cancelled) return;
              setFlow({ state: 'success', providerId: pj.provider_id, modelCount: pj.model_count });
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
  }, []);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('admin:google.title')}</DialogTitle>
        </DialogHeader>
        {flow.state === 'waiting' && (
          <div className="space-y-3 text-sm">
            <p>
              {t('admin:google.tabOpened')}<span className="font-mono">accounts.google.com</span>{t('admin:google.afterAuth')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('admin:google.tabNotOpened')}{' '}
              <a
                href={flow.authorizeUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                {t('admin:google.clickHere')}
              </a>
              .
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('admin:google.waiting')}
            </div>
          </div>
        )}
        {flow.state === 'success' && (
          <div className="text-sm text-emerald-600">
            {t('admin:google.connected')}
            {typeof flow.modelCount === 'number' ? t('admin:google.modelsLoaded', { count: flow.modelCount }) : ''}.
            {' '}{t('admin:google.available')}
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
