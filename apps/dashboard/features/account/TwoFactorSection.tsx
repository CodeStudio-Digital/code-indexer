/** Two-factor management (signed in): enroll (show the otpauth secret → confirm a
 *  code → reveal one-time recovery codes) and disable (current password + a code).
 *  The server enforces the real rules; this is the UI flow. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { useCloudAction } from '../../lib/cloud/use-cloud-action.js';

export function TwoFactorSection() {
  const { t } = useTranslation('cloud');
  const { busy, error, run } = useCloudAction();
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [pwd, setPwd] = useState('');
  const [disCode, setDisCode] = useState('');

  return (
    <div className="space-y-2">
      {recovery ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t('twofaManage.recoveryTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('twofaManage.recoveryHint')}</p>
          <pre className="rounded bg-muted p-2 text-xs">{recovery.join('\n')}</pre>
        </div>
      ) : secret ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('twofaManage.scanHint')}</p>
          <p className="text-xs">
            <span className="text-muted-foreground">{t('twofaManage.secret')}: </span>
            <code>{secret}</code>
          </p>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('field.code')} inputMode="numeric" />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button size="sm" disabled={busy} onClick={() => void run(async () => setRecovery((await cloudCall('twofa.confirm', { code })).recoveryCodes))}>
            {t('twofaManage.confirm')}
          </Button>
        </div>
      ) : disabling ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">{t('twofaManage.disableTitle')}</p>
          <Input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder={t('twofaManage.currentPassword')} autoComplete="current-password" />
          <Input value={disCode} onChange={(e) => setDisCode(e.target.value)} placeholder={t('field.code')} inputMode="numeric" />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(async () => { await cloudCall('twofa.disable', { password: pwd, code: disCode }); setDisabling(false); })}>
              {t('twofaManage.disable')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDisabling(false)}>{t('action.back')}</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => setSecret((await cloudCall('twofa.enroll', undefined)).secret))}>
            {t('twofaManage.enroll')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDisabling(true)}>{t('twofaManage.disable')}</Button>
        </div>
      )}
      {error && !secret && !disabling ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
