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

async function request(path: string, body: object, signal?: AbortSignal) {
  const response = await fetch('/api/admin/oauth/copilot/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export function CopilotConnectionDialog({ providerId, initialHost, onClose, onConnected }: Props) {
  const { t } = useTranslation(['admin', 'common']);
  const [host, setHost] = useState(initialHost?.endsWith('.ghe.com') ? initialHost : '');
  const [device, setDevice] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ controller: AbortController; flowId?: string } | null>(null);

  useEffect(() => () => {
    const active = pending.current;
    if (!active) return;
    active.controller.abort();
    if (active.flowId) void request('cancel', { device_code: active.flowId }).catch(() => {});
  }, []);

  async function connect(edition: 'individual' | 'enterprise') {
    const active: NonNullable<typeof pending.current> = { controller: new AbortController() };
    pending.current = active;
    setConnecting(true);
    setError(null);
    const { signal } = active.controller;
    try {
      const started = await request('start', { provider_id: providerId, edition, ghes_host: host }, signal);
      active.flowId = started.device_code;
      setDevice(started);
      const completed = await request('poll', { device_code: active.flowId }, signal);
      if (completed.status !== 'authorized') throw new Error(t('admin:copilot.connectFailed'));
      pending.current = null;
      await onConnected(completed.provider_id);
      onClose();
    } catch (cause) {
      if (!signal.aborted) setError((cause as Error).message);
    } finally {
      if (!signal.aborted) {
        setDevice(null);
        setConnecting(false);
      }
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('admin:copilot.title')}</DialogTitle></DialogHeader>
        {device ? (
          <div className="space-y-2 text-sm">
            <button type="button" className="text-primary underline" onClick={() => window.electronAPI?.openExternal?.(device.verification_uri)}>
              {t('admin:copilot.openGitHub')}
            </button>
            <div className="select-all rounded border p-3 text-center font-mono text-xl">{device.user_code}</div>
            <p className="text-xs text-muted-foreground">{t('admin:copilot.autoUpdate')}</p>
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
