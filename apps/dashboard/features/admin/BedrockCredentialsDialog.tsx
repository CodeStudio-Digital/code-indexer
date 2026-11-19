import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.js';

type Method = 'default' | 'iam' | 'api-key';
interface Props {
  providerId?: string;
  initialRegion?: string;
  onClose: () => void;
  onSaved: (providerId: string) => void;
}

export function BedrockCredentialsDialog({ providerId, initialRegion, onClose, onSaved }: Props) {
  const { t } = useTranslation(['admin', 'common']);
  const [method, setMethod] = useState<Method>('default');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [region, setRegion] = useState(initialRegion ?? 'us-east-1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = region.trim() && (method !== 'iam' || (accessKeyId.trim() && secretAccessKey.trim()))
    && (method !== 'api-key' || apiKey.trim());

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/oauth/bedrock/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: providerId, method, region, access_key_id: accessKeyId,
          secret_access_key: secretAccessKey, session_token: sessionToken, bedrock_api_key: apiKey,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      onSaved(result.provider_id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('admin:bedrock.title')}</DialogTitle></DialogHeader>
        <Select value={method} onValueChange={value => setMethod(value as Method)}>
          <SelectTrigger aria-label={t('admin:bedrock.authMethod')}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{t('admin:bedrock.authDefault')}</SelectItem>
            <SelectItem value="iam">{t('admin:bedrock.authIam')}</SelectItem>
            <SelectItem value="api-key">{t('admin:bedrock.authApiKey')}</SelectItem>
          </SelectContent>
        </Select>
        {method === 'default' && <p className="text-xs text-muted-foreground">{t('admin:bedrock.defaultHelp')}</p>}
        {method === 'iam' && (
          <div className="flex flex-col gap-2">
            <label className="text-xs">{t('admin:bedrock.accessKeyId')}
              <Input value={accessKeyId} onChange={event => setAccessKeyId(event.target.value)} autoComplete="off" />
            </label>
            <label className="text-xs">{t('admin:bedrock.secretAccessKey')}
              <Input type="password" value={secretAccessKey} onChange={event => setSecretAccessKey(event.target.value)} autoComplete="off" />
            </label>
            <label className="text-xs">{t('admin:bedrock.sessionToken')}
              <Input type="password" value={sessionToken} onChange={event => setSessionToken(event.target.value)} autoComplete="off" />
            </label>
          </div>
        )}
        {method === 'api-key' && (
          <label className="text-xs">{t('admin:bedrock.authApiKey')}
            <Input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" />
          </label>
        )}
        <label className="text-xs">{t('admin:bedrock.region')}
          <Input value={region} onChange={event => setRegion(event.target.value)} spellCheck={false} />
        </label>
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common:actions.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={saving || !valid}>
            {saving ? t('common:actions.saving') : t('admin:bedrock.saveCredentials')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
