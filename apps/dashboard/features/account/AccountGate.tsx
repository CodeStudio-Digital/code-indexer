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
import { Input } from '../../components/ui/input.js';
import { type AccountGateState } from './useAccountGate.js';
import { cloudStartBrowserLogin, cloudStartSsoLogin, cloudStartPortalLogin, type OAuthProviderId } from '../../lib/cloud/cloud-client.js';
import { PORTAL_URL } from '../../lib/cloud/cloud-config.js';

const PROVIDERS: { id: OAuthProviderId; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
  { id: 'microsoft', label: 'Microsoft' },
];

export function AccountGate({ gate }: { gate: AccountGateState }) {
  if (gate.decision === 'allow') return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-6">
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
  const [errCode, setErrCode] = useState<string | null>(null); // null = no error; string = failure reason
  const [ssoOrg, setSsoOrg] = useState<string | null>(null); // null = hidden; string = SSO org input shown
  const [ssoPending, setSsoPending] = useState(false);
  const [portalPending, setPortalPending] = useState(false);

  // Exactly one sign-in attempt at a time: all flows share a single 127.0.0.1
  // loopback + handoff capture, so concurrent attempts would clobber each other.
  const busy = pending != null || ssoPending || portalPending;

  const signInWithEmail = async () => {
    if (busy) return;
    setErrCode(null);
    setPortalPending(true);
    try {
      const r = await cloudStartPortalLogin();
      if (!r.ok) setErrCode(r.error ?? 'failed');
    } catch (e) {
      setErrCode(e instanceof Error ? e.message : 'failed');
    } finally {
      setPortalPending(false);
    }
  };

  const signIn = async (id: OAuthProviderId) => {
    if (busy) return;
    setErrCode(null);
    setPending(id);
    try {
      const r = await cloudStartBrowserLogin(id);
      if (!r.ok) setErrCode(r.error ?? 'failed');
      // On success, main broadcasts cloud:auth-changed → the gate flips to allow.
    } catch (e) {
      setErrCode(e instanceof Error ? e.message : 'failed');
    } finally {
      setPending(null);
    }
  };

  const startSso = async () => {
    const id = (ssoOrg ?? '').trim();
    if (!id || busy) return;
    setErrCode(null);
    setSsoPending(true);
    try {
      const r = await cloudStartSsoLogin(id);
      if (!r.ok) setErrCode(r.error ?? 'failed');
    } catch (e) {
      setErrCode(e instanceof Error ? e.message : 'failed');
    } finally {
      setSsoPending(false);
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
        <Button
          className="w-full justify-center gap-2"
          disabled={busy}
          onClick={() => void signInWithEmail()}
        >
          {portalPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('gate.emailLogin')}
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          {t('gate.or')}
          <span className="h-px flex-1 bg-border" />
        </div>
        {PROVIDERS.map((p) => (
          <Button
            key={p.id}
            variant="outline"
            className="w-full justify-center gap-2"
            disabled={busy}
            onClick={() => void signIn(p.id)}
          >
            {pending === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('gate.continueWith', { provider: p.label })}
          </Button>
        ))}
        {ssoOrg === null ? (
          <Button
            variant="outline"
            className="w-full justify-center"
            disabled={busy}
            onClick={() => setSsoOrg('')}
          >
            {t('sso.signIn')}
          </Button>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void startSso();
            }}
          >
            <Input autoFocus value={ssoOrg} onChange={(e) => setSsoOrg(e.target.value)} placeholder={t('sso.orgId')} />
            <div className="flex gap-2">
              <Button type="submit" className="flex-1 gap-2" disabled={!ssoOrg.trim() || busy}>
                {ssoPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t('sso.continue')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSsoOrg(null)}>
                {t('sso.cancel')}
              </Button>
            </div>
          </form>
        )}
      </div>
      {busy ? <p className="text-xs text-muted-foreground">{t('gate.signingIn')}</p> : null}
      {errCode ? (
        <p className="text-xs text-destructive">
          {t('gate.oauthFailed')} <span className="opacity-70">({errCode})</span>
        </p>
      ) : null}
      <div className="border-t pt-3 text-xs text-muted-foreground">
        <p>{t('gate.portalHint')}</p>
        <button type="button" className="mt-1 text-primary hover:underline" onClick={openPortal}>
          {t('gate.openPortal')}
        </button>
      </div>
    </div>
  );
}
