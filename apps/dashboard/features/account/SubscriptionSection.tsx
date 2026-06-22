/** Subscription: shows the plan and hands off to Stripe-hosted checkout / portal
 *  in the system browser (the card surface never touches the app). Checkout/portal
 *  return 501 until the Stripe keys are set on the Worker — the error surfaces. */
import { useTranslation } from 'react-i18next';
import type { CloudTier } from '@mcp/api-bus';
import { Button } from '../../components/ui/button.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { useCloudAction } from '../../lib/cloud/use-cloud-action.js';

function openExternal(url: string): void {
  (globalThis as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI?.openExternal?.(url);
}

export function SubscriptionSection({ tier }: { tier: CloudTier }) {
  const { t } = useTranslation('cloud');
  const { busy, error, run } = useCloudAction();

  return (
    <div className="space-y-3">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {tier !== 'free' ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => openExternal((await cloudCall('billing.portal', undefined)).url))}>
          {t('subscription.manage')}
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => void run(async () => openExternal((await cloudCall('billing.checkout', undefined)).url))}>
          {t('subscription.upgrade')}
        </Button>
      )}
    </div>
  );
}
