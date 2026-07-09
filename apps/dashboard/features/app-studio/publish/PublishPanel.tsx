/**
 * Painel "Publicar" — a sequência do leigo em 3 cards (só o relevante
 * "aceso"): Conectar Cloudflare (OAuth) → Publicar (deploy streamado em
 * passos humanos) → "Seu app está no ar!" (URL + copiar/abrir). Travado
 * até a checagem de qualidade aprovar; deploy roda server-side (fechar o
 * app não perde o estado — deploy_json persiste).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import type { AppStudioSessionDetail } from '../app-studio-api.js';
import { getCfWhoami, type CfWhoami, type LaunchResult } from './launch-api.js';
import { CloudflareConnectCard } from './CloudflareConnectCard.js';
import { DeployProgressCard } from './DeployProgressCard.js';
import { LiveAppCard } from './LiveAppCard.js';

export function publishTabUnlocked(detail: AppStudioSessionDetail | null): boolean {
  const review = detail?.pipeline?.stages.find((s) => s.id === 'review');
  return !!review && (review.status === 'approved' || review.status === 'skipped');
}

export function PublishPanel({ detail, onChanged }: { detail: AppStudioSessionDetail; onChanged: () => void }) {
  const { t } = useTranslation('appStudio');
  const [whoami, setWhoami] = useState<CfWhoami | null>(null);
  const [freshDeploy, setFreshDeploy] = useState<LaunchResult | null>(null);
  const sessionId = detail.session.id;
  const projectId = detail.project?.id ?? detail.session.project_id;
  const unlocked = publishTabUnlocked(detail);
  const liveUrl = freshDeploy?.url ?? detail.deploy?.url ?? null;

  // Estado de conexão CF — checado ao abrir a aba (spawn barato de whoami).
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    void getCfWhoami(sessionId).then((who) => !cancelled && setWhoami(who)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, unlocked]);

  if (!unlocked && !liveUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Lock className="h-8 w-8 text-muted-foreground/60" />
        <p className="max-w-xs text-sm text-muted-foreground">{t('publish.locked')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <h3 className="text-sm font-semibold">{t('publish.title')}</h3>

      {liveUrl && <LiveAppCard url={liveUrl} />}

      <CloudflareConnectCard sessionId={sessionId} whoami={whoami} onConnected={setWhoami} />

      {whoami?.logged_in && (
        <DeployProgressCard
          sessionId={sessionId}
          projectId={projectId}
          onDone={(result) => {
            setFreshDeploy(result);
            onChanged();
          }}
          onAuthRequired={() => setWhoami({ logged_in: false, email: null, accounts: [] })}
        />
      )}
    </div>
  );
}
