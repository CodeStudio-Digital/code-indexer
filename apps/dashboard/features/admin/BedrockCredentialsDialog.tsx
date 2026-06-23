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

interface BedrockCredentialsDialogProps {
  onClose: () => void;
  onSaved: () => void;
}

export function BedrockCredentialsDialog({ onClose, onSaved }: BedrockCredentialsDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/oauth/bedrock/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_key_id: accessKeyId,
          secret_access_key: secretAccessKey,
          session_token: sessionToken || undefined,
          region,
        }),
      });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('admin:bedrock.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {t('admin:bedrock.description')}
          </p>
          <div>
            <label className="text-xs font-medium">{t('admin:bedrock.accessKeyId')}</label>
            <Input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder={t('admin:bedrock.accessKeyPlaceholder')} />
          </div>
          <div>
            <label className="text-xs font-medium">{t('admin:bedrock.secretAccessKey')}</label>
            <Input
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium">{t('admin:bedrock.sessionToken')}</label>
            <Input type="password" value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium">{t('admin:bedrock.region')}</label>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder={t('admin:bedrock.regionPlaceholder')} />
          </div>
          {error && <div className="text-xs text-red-600 break-all">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={submit} disabled={saving || !accessKeyId || !secretAccessKey || !region}>
            {saving ? t('common:actions.saving') : t('admin:bedrock.saveCredentials')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
