/**
 * A compact Free/Pro/Team feature comparison shown in the subscription modal, so a
 * user can SEE what upgrading unlocks (today the only upgrade affordance is buried
 * in per-feature dialogs). No prices are hardcoded here — the actual amounts live
 * in Stripe + the public pricing page; this is the in-app "what do I get" view.
 * Copy stays in the `cloud` i18n namespace (keeps the literal-baseline check green).
 */
import { useTranslation } from 'react-i18next';
import { Check, Minus } from 'lucide-react';
import type { CloudTier } from '@mcp/api-bus';
import { cn } from '../../lib/utils.js';
import { UpgradeNotice } from '../../components/UpgradeNotice.js';

type FeatureKey =
  | 'sharing'
  | 'sync'
  | 'apiDocs'
  | 'backup'
  | 'sshVault'
  | 'teamApis'
  | 'teamMemory'
  | 'teamSshVault';

const COLUMNS = ['free', 'pro', 'team'] as const;
type Column = (typeof COLUMNS)[number];

// Truth table mirrors the GRANTS in @cloudstudio/cloud-billing (entitlements.ts).
const MATRIX: Record<FeatureKey, Record<Column, boolean>> = {
  sharing: { free: false, pro: true, team: true },
  sync: { free: false, pro: true, team: true },
  apiDocs: { free: false, pro: true, team: true },
  backup: { free: false, pro: true, team: true },
  sshVault: { free: false, pro: true, team: true },
  teamApis: { free: false, pro: false, team: true },
  teamMemory: { free: false, pro: false, team: true },
  teamSshVault: { free: false, pro: false, team: true },
};
const ORDER: FeatureKey[] = ['sharing', 'sync', 'apiDocs', 'backup', 'sshVault', 'teamApis', 'teamMemory', 'teamSshVault'];

export function PlanMatrix({ tier }: { tier: CloudTier }) {
  const { t } = useTranslation('cloud');
  const current: Column | null = tier === 'pro' || tier === 'team' || tier === 'free' ? tier : null;
  return (
    <div className="space-y-3">
      {tier === 'free' ? <UpgradeNotice message={t('plans.localFree')} cta={t('subscription.upgrade')} /> : null}
      <div className="overflow-hidden rounded-md border text-sm">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b bg-muted/40 text-xs">
              <th className="px-2 py-1.5 text-left font-medium">{t('plans.heading')}</th>
              {COLUMNS.map((col) => (
                <th key={col} className={cn('px-2 py-1.5 text-center font-medium', col === current && 'text-primary')}>
                  {t(`tierName.${col}`)}
                  {col === current ? <span className="block text-[10px] font-normal text-muted-foreground">{t('plans.current')}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ORDER.map((f) => (
              <tr key={f} className="border-b last:border-0">
                <td className="px-2 py-1.5 text-muted-foreground">{t(`plans.feature.${f}`)}</td>
                {COLUMNS.map((col) => (
                  <td key={col} className={cn('px-2 py-1.5 text-center', col === current && 'bg-primary/5')}>
                    {MATRIX[f][col] ? (
                      <Check className="mx-auto h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Minus className="mx-auto h-3.5 w-3.5 text-muted-foreground/40" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
