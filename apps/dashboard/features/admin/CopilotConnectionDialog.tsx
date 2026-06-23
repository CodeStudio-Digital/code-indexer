import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import type { CopilotFlowState, CopilotOpts } from './types.js';

interface CopilotConnectionDialogProps {
  onClose: () => void;
  /** Called after a successful connection so the parent can reload providers. */
  onConnected: (providerId?: string) => Promise<void> | void;
}

export function CopilotConnectionDialog({ onClose, onConnected }: CopilotConnectionDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [flow, setFlow] = useState<CopilotFlowState>({ state: 'picker' });
  const [enterpriseHost, setEnterpriseHost] = useState('');
  const [enterpriseIntegrationId, setEnterpriseIntegrationId] = useState('');

  async function runFlow(opts: CopilotOpts) {
    setFlow({ state: 'idle' });
    try {
      const r = await fetch('/api/admin/oauth/copilot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const j = (await r.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        interval: number;
        opts?: CopilotOpts;
        error?: string;
      };
      if (!j.device_code) throw new Error(j.error ?? 'unexpected response');
      setFlow({
        state: 'waiting',
        userCode: j.user_code,
        verificationUri: j.verification_uri,
        deviceCode: j.device_code,
      });
      const resolvedOpts = j.opts ?? opts;
      const poll = async () => {
        try {
          const p = await fetch('/api/admin/oauth/copilot/poll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: j.device_code, opts: resolvedOpts }),
          });
          const pj = (await p.json()) as {
            status: string;
            error?: string;
            provider_id?: string;
            model_count?: number;
          };
          if (pj.status === 'authorized') {
            setFlow({ state: 'success', providerId: pj.provider_id, modelCount: pj.model_count });
            await onConnected(pj.provider_id);
            return;
          }
          if (pj.status === 'expired' || pj.status === 'error') {
            setFlow({ state: 'error', message: pj.error ?? 'flow expired' });
            return;
          }
          setTimeout(() => {
            void poll();
          }, Math.max((j.interval ?? 5) * 1000, 5000));
        } catch (e) {
          setFlow({ state: 'error', message: (e as Error).message });
        }
      };
      void poll();
    } catch (e) {
      setFlow({ state: 'error', message: (e as Error).message });
    }
  }

  function submitEnterprise() {
    const host = enterpriseHost.trim();
    if (!host) {
      setFlow({ state: 'error', message: 'GHES host is required' });
      return;
    }
    void runFlow({
      edition: 'enterprise',
      ghes_host: host,
      integration_id: enterpriseIntegrationId.trim() || undefined,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('admin:copilot.title')}</DialogTitle>
        </DialogHeader>
        {flow.state === 'picker' && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {t('admin:copilot.description')}
            </p>
            <div className="grid gap-2">
              <Button
                variant="outline"
                className="justify-start h-auto py-3"
                onClick={() => void runFlow({ edition: 'individual' })}
              >
                <div className="text-left">
                  <div className="font-medium">{t('admin:copilot.individual')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('admin:copilot.individualDesc')}
                  </div>
                </div>
              </Button>
              <Button
                variant="outline"
                className="justify-start h-auto py-3"
                onClick={() => setFlow({ state: 'enterprise_form' })}
              >
                <div className="text-left">
                  <div className="font-medium">{t('admin:copilot.enterprise')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('admin:copilot.enterpriseDesc')}
                  </div>
                </div>
              </Button>
            </div>
          </div>
        )}
        {flow.state === 'enterprise_form' && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              {t('admin:copilot.ghesHelp')}
            </p>
            <div>
              <label className="text-xs font-medium">{t('admin:copilot.ghesHost')}</label>
              <Input
                value={enterpriseHost}
                onChange={(e) => setEnterpriseHost(e.target.value)}
                placeholder={t('admin:copilot.ghesHostPlaceholder')}
              />
            </div>
            <div>
              <label className="text-xs font-medium">{t('admin:copilot.integrationId')}</label>
              <Input
                value={enterpriseIntegrationId}
                onChange={(e) => setEnterpriseIntegrationId(e.target.value)}
                placeholder={t('admin:copilot.integrationIdPlaceholder')}
              />
            </div>
          </div>
        )}
        {flow.state === 'waiting' && (
          <div className="space-y-3 text-sm">
            <p>
              {t('admin:copilot.openUrl')}{' '}
              <a
                href={flow.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                {flow.verificationUri}
              </a>{' '}
              {t('admin:copilot.typeCode')}
            </p>
            <div className="font-mono text-2xl font-bold tracking-widest text-center py-4 bg-muted rounded-lg">
              {flow.userCode}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin:copilot.autoUpdate')}
            </p>
          </div>
        )}
        {flow.state === 'success' && (
          <div className="text-sm text-emerald-600">
            {t('admin:copilot.connected')}
            {typeof flow.modelCount === 'number' ? ` \u2014 ${flow.modelCount} models loaded` : ''}.
            {' '}{t('admin:copilot.available')}
          </div>
        )}
        {flow.state === 'error' && <div className="text-sm text-red-600 break-all">{flow.message}</div>}
        <DialogFooter>
          {flow.state === 'enterprise_form' && (
            <Button onClick={submitEnterprise} disabled={!enterpriseHost.trim()}>
              {t('admin:copilot.continue')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
