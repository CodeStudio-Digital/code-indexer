/**
 * Sign-in gate. When signed out → a browser-OAuth sign-in card; while verifying →
 * a brief splash. Returns null once signed in, so the app shows through.
 *
 * Desktop is OAuth-ONLY (P7-B): the in-app email/password form is gone — sign-in
 * opens the system browser (Google/GitHub/Microsoft) and returns via the loopback
 * handoff. Email/password lives on the web account portal (apps/account-portal).
 * There is NO subscription paywall — the local IDE is
 * free at ANY tier; cloud FEATURES gate per-use (server-enforced). Sign-in is
 * required only so we know who's using the app.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useAccountGate } from './useAccountGate.js';
import { cloudStartBrowserLogin, type OAuthProviderId } from '../../lib/cloud/cloud-client.js';
import { PORTAL_URL } from '../../lib/cloud/cloud-config.js';

const PROVIDERS: { id: OAuthProviderId; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
  { id: 'microsoft', label: 'Microsoft' },
];

export function AccountGate() {
  const gate = useAccountGate();
  if (gate.decision === 'allow') return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-6 backdrop-blur">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-2xl">
        {gate.decision === 'loading' ? <GateLoading /> : null}
        {gate.decision === 'login' ? <GateLogin /> : null}
      </div>
    </div>
  );
}

function GateLoading() {
  const { t } = useTranslation('cloud');
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {t('gate.checking')}
    </div>
  );
}

function GateLogin() {
  const { t } = useTranslation('cloud');
  const [pending, setPending] = useState<OAuthProviderId | null>(null);
  const [failed, setFailed] = useState(false);

  const signIn = async (id: OAuthProviderId) => {
    setFailed(false);
    setPending(id);
    try {
      const r = await cloudStartBrowserLogin(id);
      if (!r.ok) setFailed(true);
      // On success, main broadcasts cloud:auth-changed → the gate flips to allow.
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  const openPortal = () => {
    (globalThis as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI?.openExternal?.(`${PORTAL_URL}/login`);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Cloud className="h-5 w-5 text-primary" />
        <h2 className="text-base font-semibold">{t('gate.welcome')}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{t('gate.signInOAuth')}</p>
      <div className="space-y-2">
        {PROVIDERS.map((p) => (
          <Button
            key={p.id}
            variant="outline"
            className="w-full justify-center gap-2"
            disabled={pending != null}
            onClick={() => void signIn(p.id)}
          >
            {pending === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('gate.continueWith', { provider: p.label })}
          </Button>
        ))}
      </div>
      {pending ? <p className="text-xs text-muted-foreground">{t('gate.signingIn')}</p> : null}
      {failed ? <p className="text-xs text-destructive">{t('gate.oauthFailed')}</p> : null}
      <div className="border-t pt-3 text-xs text-muted-foreground">
        <p>{t('gate.portalHint')}</p>
        <button type="button" className="mt-1 text-primary hover:underline" onClick={openPortal}>
          {t('gate.openPortal')}
        </button>
      </div>
    </div>
  );
}
