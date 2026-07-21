import { useState } from 'react';
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
import { connectKimiCodeApiToken } from './api.js';
import type { AdminProvider } from './types.js';

interface KimiCodeConnectionDialogProps {
  provider?: AdminProvider;
  onClose: () => void;
  onConnected: (providerId?: string) => Promise<void> | void;
}

export function KimiCodeConnectionDialog({ provider, onClose, onConnected }: KimiCodeConnectionDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [apiToken, setApiToken] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'success'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [modelCount, setModelCount] = useState<number | null>(null);

  async function connect() {
    const token = apiToken.trim();
    if (!token) {
      setError(t('admin:kimiCode.tokenRequired'));
      return;
    }
    setState('saving');
    setError(null);
    try {
      const result = await connectKimiCodeApiToken(provider?.id ?? 'kimi-code', token);
      setApiToken('');
      setModelCount(result.model_count);
      setState('success');
      await onConnected(result.provider_id);
    } catch (e) {
      setState('idle');
      setError((e as Error).message);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('admin:kimiCode.title')}</DialogTitle>
        </DialogHeader>
        {state !== 'success' && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t('admin:kimiCode.tokenHelp')}</p>
            <div className="space-y-1.5">
              <label className="text-xs font-medium" htmlFor="kimi-code-api-token">
                {t('admin:kimiCode.tokenLabel')}
              </label>
              <Input
                id="kimi-code-api-token"
                type="password"
                autoComplete="off"
                autoFocus
                value={apiToken}
                onChange={(event) => setApiToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && state !== 'saving') void connect();
                }}
                placeholder={t('admin:kimiCode.tokenPlaceholder')}
                disabled={state === 'saving'}
              />
            </div>
            {state === 'saving' && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t('admin:kimiCode.connecting')}
              </div>
            )}
          </div>
        )}
        {state === 'success' && (
          <div className="text-sm text-emerald-600">
            {t('admin:kimiCode.connected')}
            {typeof modelCount === 'number' ? t('admin:kimiCode.modelsLoaded', { count: modelCount }) : ''}.
            {' '}{t('admin:kimiCode.available')}
          </div>
        )}
        {error && <div className="text-sm text-red-600 break-all">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
          {state !== 'success' && (
            <Button onClick={() => void connect()} disabled={state === 'saving' || !apiToken.trim()}>
              {state === 'saving' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('admin:kimiCode.connect')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
