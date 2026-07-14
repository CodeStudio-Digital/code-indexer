/**
 * Card "Conectar Cloudflare": explainer leigo, botão que roda o wrangler
 * login (OAuth no browser — mostramos o link se o browser não abrir),
 * link "criar conta grátis" e o estado conectado (email/conta).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Cloud, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { streamCfLogin, type CfWhoami } from './launch-api.js';

export function CloudflareConnectCard({
  sessionId,
  whoami,
  onConnected,
}: {
  sessionId: number;
  whoami: CfWhoami | null;
  onConnected: (who: CfWhoami) => void;
}) {
  const { t } = useTranslation('appStudio');
  const [busy, setBusy] = useState(false);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (whoami?.logged_in) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-500/40 bg-green-500/5 px-3 py-2.5 text-sm">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
        <span className="min-w-0 flex-1 truncate">
          {t('publish.connect.connected', { defaultValue: 'Conectado como' })}{' '}
          <span className="font-medium">{whoami.email ?? whoami.accounts[0]?.name ?? 'Cloudflare'}</span>
        </span>
      </div>
    );
  }

  async function connect() {
    setBusy(true);
    setError(null);
    setOauthUrl(null);
    try {
      const who = await streamCfLogin(sessionId, { onOauthUrl: setOauthUrl });
      onConnected(who);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setOauthUrl(null);
    }
  }

  return (
    <div className="space-y-2.5 rounded-lg border p-3">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Cloud className="h-4 w-4 text-primary" />
        {t('publish.connect.title', { defaultValue: 'Conecte sua conta Cloudflare' })}
      </p>
      <p className="text-xs text-muted-foreground">{t('workflow.publishIsExplicit')}</p>
      <Button size="sm" className="w-full" disabled={busy} onClick={() => void connect()}>
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Cloud className="mr-1 h-3.5 w-3.5" />}
        {busy
          ? t('publish.connect.waiting', { defaultValue: 'Aguardando você no navegador…' })
          : t('publish.connect.cta', { defaultValue: 'Conectar (abre o navegador)' })}
      </Button>
      {oauthUrl && (
        <p className="text-[11px] text-muted-foreground">
          {t('publish.connect.manualLink', { defaultValue: 'O navegador não abriu?' })}{' '}
          <a href={oauthUrl} target="_blank" rel="noreferrer" className="text-primary underline">
            {t('publish.connect.openLink', { defaultValue: 'Clique aqui' })}
          </a>
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {t('publish.connect.noAccount', { defaultValue: 'Não tem conta?' })}{' '}
        <a
          href="https://dash.cloudflare.com/sign-up"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-primary underline"
        >
          {t('publish.connect.createFree', { defaultValue: 'Crie grátis em 2 minutos' })}
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </p>
      {error && <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}
    </div>
  );
}
