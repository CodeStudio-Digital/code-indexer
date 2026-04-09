import { useState } from 'react';
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
          <DialogTitle>Connect GitHub Copilot</DialogTitle>
        </DialogHeader>
        {flow.state === 'picker' && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Choose which Copilot edition to connect. You can have both connected side-by-side.
            </p>
            <div className="grid gap-2">
              <Button
                variant="outline"
                className="justify-start h-auto py-3"
                onClick={() => void runFlow({ edition: 'individual' })}
              >
                <div className="text-left">
                  <div className="font-medium">Individual / Business</div>
                  <div className="text-xs text-muted-foreground">
                    github.com · Copilot Individual or Business subscription
                  </div>
                </div>
              </Button>
              <Button
                variant="outline"
                className="justify-start h-auto py-3"
                onClick={() => setFlow({ state: 'enterprise_form' })}
              >
                <div className="text-left">
                  <div className="font-medium">Enterprise (GHES)</div>
                  <div className="text-xs text-muted-foreground">
                    GitHub Enterprise Server · custom host + integration id
                  </div>
                </div>
              </Button>
            </div>
          </div>
        )}
        {flow.state === 'enterprise_form' && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Enter your GitHub Enterprise Server host. Device flow and token exchange will run against
              this domain.
            </p>
            <div>
              <label className="text-xs font-medium">GHES host</label>
              <Input
                value={enterpriseHost}
                onChange={(e) => setEnterpriseHost(e.target.value)}
                placeholder="github.acme.com"
              />
            </div>
            <div>
              <label className="text-xs font-medium">Copilot-Integration-Id (optional)</label>
              <Input
                value={enterpriseIntegrationId}
                onChange={(e) => setEnterpriseIntegrationId(e.target.value)}
                placeholder="copilot-chat"
              />
            </div>
          </div>
        )}
        {flow.state === 'waiting' && (
          <div className="space-y-3 text-sm">
            <p>
              Open{' '}
              <a
                href={flow.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                {flow.verificationUri}
              </a>{' '}
              and type the code below:
            </p>
            <div className="font-mono text-2xl font-bold tracking-widest text-center py-4 bg-muted rounded-lg">
              {flow.userCode}
            </div>
            <p className="text-xs text-muted-foreground">
              This page will update automatically once you authorize in GitHub.
            </p>
          </div>
        )}
        {flow.state === 'success' && (
          <div className="text-sm text-emerald-600">
            Copilot connected successfully
            {typeof flow.modelCount === 'number' ? ` — ${flow.modelCount} models loaded` : ''}.
            The provider is now available in the Chat tab.
          </div>
        )}
        {flow.state === 'error' && <div className="text-sm text-red-600 break-all">{flow.message}</div>}
        <DialogFooter>
          {flow.state === 'enterprise_form' && (
            <Button onClick={submitEnterprise} disabled={!enterpriseHost.trim()}>
              Continue
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
