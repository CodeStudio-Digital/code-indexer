import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';

interface ClaudeCodeRateLimitBucket {
  key: 'five_hour' | 'seven_day' | 'overage';
  label: string;
  utilization: number;
  resetsAt: number | null;
  windowSeconds: number | null;
}

interface ClaudeCodeRateLimitSnapshot {
  source: 'headers' | 'quota_check';
  checkedAt: string;
  status: string;
  utilization: number | null;
  rateLimitType: string | null;
  resetsAt: number | null;
  isUsingOverage: boolean;
  overageStatus: string | null;
  overageResetsAt: number | null;
  overageDisabledReason: string | null;
  upgradePaths: string[];
  unifiedRateLimitFallbackAvailable: boolean;
  buckets: ClaudeCodeRateLimitBucket[];
}

interface ClaudeCodeUsage {
  packageVersion: string;
  authType: string;
  profile: {
    account?: {
      email?: string;
      email_address?: string;
      display_name?: string;
    };
    organization?: {
      name?: string;
      organization_type?: string;
      rate_limit_tier?: string;
      seat_tier?: string;
      billing_type?: string;
      has_extra_usage_enabled?: boolean;
    };
  } | null;
  profileInfo: {
    subscriptionType: string | null;
    rateLimitTier: string | null;
    seatTier: string | null;
    billingType: string | null;
    hasExtraUsageEnabled: boolean | null;
  } | null;
  roles: {
    organization_role?: string;
    workspace_role?: string;
    organization_name?: string;
  } | null;
  metrics: {
    metricsLoggingEnabled: boolean | null;
    hasError: boolean;
  };
  rateLimits: ClaudeCodeRateLimitSnapshot | null;
  limitProbeError: string | null;
}

interface ClaudeCodeUsagePanelProps {
  providerId: string;
}

function bucketColor(utilization: number): string {
  if (utilization >= 1) return 'bg-red-500';
  if (utilization >= 0.8) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function statusVariant(status: string): 'success' | 'warning' | 'destructive' | 'outline' {
  if (status === 'allowed') return 'success';
  if (status === 'allowed_warning') return 'warning';
  if (status === 'rejected') return 'destructive';
  return 'outline';
}

export function ClaudeCodeUsagePanel({ providerId }: ClaudeCodeUsagePanelProps) {
  const { t } = useTranslation('admin');
  const [usage, setUsage] = useState<ClaudeCodeUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingLimits, setCheckingLimits] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (probeLimits = false) => {
    if (probeLimits) setCheckingLimits(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ provider_id: providerId });
      if (probeLimits) params.set('probe', '1');
      const r = await fetch(`/api/admin/oauth/claude-code/usage?${params.toString()}`);
      const j = (await r.json()) as ClaudeCodeUsage & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setUsage(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (probeLimits) setCheckingLimits(false);
      else setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  if (loading && !usage) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> {t('claudeCode.usageLoading')}
      </div>
    );
  }

  if (error && !usage) {
    return <div className="py-3 text-sm text-red-600">{error}</div>;
  }

  if (!usage) return null;

  const account = usage.profile?.account;
  const org = usage.profile?.organization;
  const info = usage.profileInfo;
  const email = account?.email ?? account?.email_address;
  const metricText = usage.metrics.hasError
    ? t('claudeCode.metricsUnknown')
    : usage.metrics.metricsLoggingEnabled
      ? t('claudeCode.metricsEnabled')
      : t('claudeCode.metricsDisabled');
  const rateLimits = usage.rateLimits;
  const formatReset = (value: number | null) => (
    value ? new Date(value * 1000).toLocaleString() : t('claudeCode.limitNoReset')
  );
  const labelForBucket = (bucket: ClaudeCodeRateLimitBucket) => {
    if (bucket.key === 'five_hour') return t('claudeCode.limitFiveHour');
    if (bucket.key === 'seven_day') return t('claudeCode.limitSevenDay');
    return t('claudeCode.limitOverage');
  };

  return (
    <div className="space-y-3 py-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t('claudeCode.officialUsage')}</span>
          <Badge variant="outline">Claude Code {usage.packageVersion}</Badge>
          <Badge variant="secondary">{usage.authType}</Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <div className="text-muted-foreground">{t('claudeCode.account')}</div>
          <div className="font-mono truncate">{account?.display_name ?? email ?? t('claudeCode.unavailable')}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('claudeCode.organization')}</div>
          <div className="font-mono truncate">{org?.name ?? usage.roles?.organization_name ?? t('claudeCode.unavailable')}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('claudeCode.subscription')}</div>
          <div className="font-mono truncate">{info?.subscriptionType ?? org?.organization_type ?? t('claudeCode.unavailable')}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('claudeCode.rateLimitTier')}</div>
          <div className="font-mono truncate">{info?.rateLimitTier ?? org?.rate_limit_tier ?? t('claudeCode.unavailable')}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('claudeCode.billing')}</div>
          <div className="font-mono truncate">{info?.billingType ?? org?.billing_type ?? t('claudeCode.unavailable')}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('claudeCode.metrics')}</div>
          <div className="font-mono truncate">{metricText}</div>
        </div>
      </div>

      <div className="space-y-2 rounded-md border border-border/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <BarChart3 className="h-4 w-4" />
            {t('claudeCode.usageLimits')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {rateLimits ? (
              <Badge variant={statusVariant(rateLimits.status)}>
                {rateLimits.status}
              </Badge>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load(true)}
              disabled={checkingLimits}
            >
              {checkingLimits ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3 w-3" />
              )}
              {checkingLimits ? t('claudeCode.checkingLimits') : t('claudeCode.checkLimits')}
            </Button>
          </div>
        </div>

        {usage.limitProbeError ? (
          <div className="text-xs text-red-600">
            {t('claudeCode.limitProbeFailed', { error: usage.limitProbeError })}
          </div>
        ) : null}

        {rateLimits ? (
          <div className="space-y-3">
            <div className="grid gap-2 text-xs sm:grid-cols-3">
              <div>
                <div className="text-muted-foreground">{t('claudeCode.limitStatus')}</div>
                <div className="font-mono truncate">
                  {rateLimits.rateLimitType ?? rateLimits.status}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">{t('claudeCode.limitReset')}</div>
                <div className="font-mono truncate">
                  {formatReset(rateLimits.resetsAt ?? rateLimits.overageResetsAt)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">{t('claudeCode.limitSource')}</div>
                <div className="font-mono truncate">{rateLimits.source}</div>
              </div>
            </div>

            {rateLimits.buckets.length > 0 ? (
              <div className="space-y-2">
                {rateLimits.buckets.map((bucket) => {
                  const pct = Math.max(0, Math.min(100, Math.round(bucket.utilization * 100)));
                  return (
                    <div key={bucket.key} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium">{labelForBucket(bucket)}</span>
                        <span className="font-mono text-muted-foreground">{pct}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${bucketColor(bucket.utilization)}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {t('claudeCode.limitResetShort', { time: formatReset(bucket.resetsAt) })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {t('claudeCode.limitsNoBuckets')}
              </div>
            )}

            <div className="text-[11px] text-muted-foreground">
              {t('claudeCode.officialLimitHeaders')}
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {t('claudeCode.limitsUnavailable')}
          </div>
        )}
      </div>
    </div>
  );
}
