/** Post-checkout landing. Stripe redirects here after payment. We reconcile
 *  immediately (api.billingSync) in case the `checkout.session.completed` webhook
 *  hasn't landed yet, then reload account + entitlements so the new tier shows up
 *  without the user wondering whether their payment worked. */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '../lib/ui.js';

const TIER_LABEL: Record<string, string> = { free: 'Free', pro: 'Pro', team: 'Teams', enterprise: 'Enterprise' };

export function BillingSuccessPage() {
  const { entitlements, reload } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<'syncing' | 'done' | 'pending'>('syncing');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // guard React 18 StrictMode's double-invoke
    ran.current = true;
    void (async () => {
      try {
        await api.billingSync(); // self-heal if the webhook is delayed/dropped
        await reload(); // refresh account + entitlements
        setState('done');
      } catch {
        // The webhook is still the primary path; reconcile is best-effort. Tell the
        // user it's coming rather than implying failure (their card WAS charged).
        await reload().catch(() => {});
        setState('pending');
      }
    })();
  }, [reload]);

  const tier = entitlements?.tier ?? 'pro';

  return (
    <div className="mx-auto max-w-md py-16">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-success" /> Payment received
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {state === 'syncing' ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Activating your plan…
            </div>
          ) : state === 'pending' ? (
            <Alert tone="info">
              Thanks — your payment went through. Your plan will activate within a minute; this page will reflect it
              after a refresh.
            </Alert>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Your plan</span>
              <Badge tone="success">{TIER_LABEL[tier] ?? tier}</Badge>
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <Button size="sm" onClick={() => navigate('/billing')}>
              Go to billing
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate('/')}>
              Overview
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
