import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';

interface QuotaBucket {
  modelId: string;
  remainingAmount: number;
  limit: number;
  remainingFraction: number;
  resetTime: string | null;
}

interface UserQuota {
  tier: string;
  tierName: string;
  buckets: QuotaBucket[];
  credits: number | null;
}

interface GoogleQuotaPanelProps {
  providerId: string;
}

export function GoogleQuotaPanel({ providerId }: GoogleQuotaPanelProps) {
  const { t } = useTranslation('admin');
  const [quota, setQuota] = useState<UserQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/oauth/google/quota?provider_id=${encodeURIComponent(providerId)}`);
      const j = (await r.json()) as UserQuota & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setQuota(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  if (loading && !quota) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> {t('google.quotaLoading')}
      </div>
    );
  }

  if (error && !quota) {
    return <div className="py-3 text-sm text-red-600">{error}</div>;
  }

  if (!quota) return null;

  const formatReset = (iso: string | null) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = d.getTime() - now.getTime();
      if (diffMs <= 0) return 'now';
      const mins = Math.round(diffMs / 60000);
      if (mins < 60) return `${mins}m`;
      const hrs = Math.round(mins / 60);
      return `${hrs}h`;
    } catch {
      return '';
    }
  };

  /** Percentage from remainingFraction (primary) or absolute values (fallback). */
  const pct = (b: QuotaBucket) => Math.round(b.remainingFraction * 100);

  const barColor = (p: number) => {
    if (p > 50) return 'bg-emerald-500';
    if (p > 20) return 'bg-amber-500';
    return 'bg-red-500';
  };

  const quotaLabel = (b: QuotaBucket) => {
    if (b.limit !== null && b.remainingAmount !== null) {
      return `${b.remainingAmount}/${b.limit}`;
    }
    return `${pct(b)}%`;
  };

  return (
    <div className="space-y-3 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t('google.quota')}</span>
          <Badge variant="outline">{quota.tierName}</Badge>
          {quota.credits !== null && (
            <Badge variant="secondary">
              {quota.credits}{t('google.aiCredits')}
            </Badge>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {quota.buckets.length === 0 ? (
        <div className="text-sm text-muted-foreground">{t('google.noQuota')}</div>
      ) : (
        <div className="space-y-2">
          {quota.buckets.map((b) => {
            const p = pct(b);
            const reset = formatReset(b.resetTime);
            return (
              <div key={b.modelId} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono">{b.modelId}</span>
                  <span className="text-muted-foreground">
                    {quotaLabel(b)}
                    {reset ? ` (${t('google.quotaReset', { time: reset })})` : ''}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-all ${barColor(p)}`}
                    style={{ width: `${Math.max(p, 1)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
