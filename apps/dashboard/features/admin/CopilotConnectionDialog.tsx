import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';

interface Props {
  providerId?: string;
  initialHost?: string;
  onClose: () => void;
  onConnected: (providerId: string) => Promise<void> | void;
}

type Device = { device_code: string; user_code: string; verification_uri: string };
type Account = { selectionId: string; login: string; host: string };
type Step = { kind: 'device'; device: Device } | { kind: 'accounts'; accounts: Account[] };
type PollResponse =
  | { status: 'authorized'; provider_id: string }
  | { status: 'pending'; interval: number }
  | { status: 'choose_account'; accounts: Account[] };
type Attempt = { controller: AbortController; flowId?: string; timer?: ReturnType<typeof setTimeout> };

async function request<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/admin/oauth/copilot/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || `HTTP ${response.status}`), { code: result.code ?? result.status });
  return result as T;
}

function cancelFlow(flowId: string) {
  void request('cancel', { device_code: flowId }).catch(() => {});
}

export function CopilotConnectionDialog({ providerId, initialHost, onClose, onConnected }: Props) {
  const { t } = useTranslation(['admin', 'common']);
  const [host, setHost] = useState(initialHost?.endsWith('.ghe.com') ? initialHost : '');
  const [step, setStep] = useState<Step | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Attempt | null>(null);

  useEffect(() => () => {
    const active = pending.current;
    if (!active) return;
    pending.current = null;
    clearTimeout(active.timer);
    active.controller.abort();
    if (active.flowId) cancelFlow(active.flowId);
  }, []);

  function showFailure(active: Attempt, cause: unknown) {
    if (pending.current !== active) return;
    pending.current = null;
    if (active.flowId) cancelFlow(active.flowId);
    const code = (cause as { code?: string } | undefined)?.code;
    const message = code === 'expired' ? t('admin:copilot.codeExpired')
      : code === 'credential_store_unavailable' ? t('admin:copilot.credentialVaultUnavailable')
      : cause instanceof Error ? cause.message : t('admin:copilot.connectFailed');
    setError(message);
    setStep(null);
    setConnecting(false);
  }

  async function advance(active: Attempt, selectionId?: string) {
    setConnecting(true);
    try {
      const result = await request<PollResponse>('poll', {
        device_code: active.flowId, selection_id: selectionId,
      }, active.controller.signal);
      if (pending.current !== active) return;
      if (result.status === 'pending') {
        active.timer = setTimeout(() => void advance(active), result.interval * 1000);
      } else if (result.status === 'choose_account') {
        setStep({ kind: 'accounts', accounts: result.accounts });
        setConnecting(false);
      } else if (result.status === 'authorized') {
        active.flowId = undefined;
        await onConnected(result.provider_id);
        if (pending.current === active) {
          pending.current = null;
          onClose();
        }
      } else {
        throw new Error(t('admin:copilot.connectFailed'));
      }
    } catch (cause) {
      showFailure(active, cause);
    }
  }

  async function connect(edition: 'individual' | 'enterprise') {
    const active: Attempt = { controller: new AbortController() };
    pending.current = active;
    setConnecting(true);
    setError(null);
    try {
      const started = await request<Device>('start', { provider_id: providerId, edition, ghes_host: host }, active.controller.signal);
      if (pending.current !== active) {
        cancelFlow(started.device_code);
        return;
      }
      active.flowId = started.device_code;
      setStep({ kind: 'device', device: started });
      await advance(active);
    } catch (cause) {
      showFailure(active, cause);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('admin:copilot.title')}</DialogTitle></DialogHeader>
        {step?.kind === 'device' ? (
          <div className="space-y-2 text-sm">
            <button type="button" className="text-primary underline" onClick={() => window.electronAPI?.openExternal?.(step.device.verification_uri)}>
              {t('admin:copilot.openGitHub')}
            </button>
            <div className="select-all rounded border p-3 text-center font-mono text-xl">{step.device.user_code}</div>
            <p role="status" className="text-xs text-muted-foreground">{t('admin:copilot.autoUpdate')}</p>
          </div>
        ) : step?.kind === 'accounts' ? (
          <div className="space-y-2 text-sm">
            <p>{t('admin:copilot.chooseAccount')}</p>
            {step.accounts.map(account => (
              <Button key={account.selectionId} variant="outline" className="w-full justify-start" disabled={connecting}
                onClick={() => { if (pending.current) void advance(pending.current, account.selectionId); }}>
                {account.login} · {account.host}
              </Button>
            ))}
            {connecting && <p role="status" className="text-xs text-muted-foreground">{t('common:actions.loading')}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <Button onClick={() => void connect('individual')} disabled={connecting}>{t('admin:copilot.individual')}</Button>
            <label className="block text-xs">{t('admin:copilot.ghesHost')}
              <Input value={host} onChange={event => setHost(event.target.value)} placeholder="org.ghe.com" spellCheck={false} />
            </label>
            <Button variant="outline" onClick={() => void connect('enterprise')} disabled={connecting || !host.trim()}>
              {t('admin:copilot.enterprise')}
            </Button>
            {connecting && <p role="status" className="text-xs text-muted-foreground">{t('common:actions.loading')}</p>}
          </div>
        )}
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
        <DialogFooter><Button variant="ghost" onClick={onClose}>{t('common:actions.close')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
