/** Billing — current plan, feature/limit breakdown, and upgrade / manage actions.
 *  Reads entitlements from useAuth (non-critical, may be null) and refreshes on
 *  mount. Stripe handoff redirects the browser; if billing isn't configured the
 *  Worker returns 501 (entitlement / billing_not_configured) which we surface inline. */
import { useEffect, useState } from 'react';
import { CheckCircle2, Minus } from 'lucide-react';
import type { Entitlements } from '@mcp/api-bus';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '../lib/ui.js';

const TIER_LABEL: Record<string, string> = { free: 'Free', pro: 'Pro', team: 'Teams', enterprise: 'Enterprise' };

const FEATURE_LABEL: Record<keyof Entitlements['features'], string> = {
  sharing: 'Conversation sharing',
  sync: 'Multi-device sync',
  apiDocs: 'Hosted API docs',
  backup: 'Cloud backups',
  teamApis: 'Shared team workspaces',
  teamMemory: 'Team knowledge base',
  teamTemplates: 'Shared templates',
  sso: 'SSO/SCIM',
  auditExport: 'Audit export',
  prioritySupport: 'Priority support',
  sshVault: 'SSH secrets vault',
  teamSshVault: 'Team SSH vault',
};
const FEATURE_ORDER: (keyof Entitlements['features'])[] = [
  'sharing',
  'sync',
  'apiDocs',
  'backup',
  'teamApis',
  'teamMemory',
  'teamTemplates',
  'sso',
  'auditExport',
  'prioritySupport',
  'sshVault',
  'teamSshVault',
];

const LIMIT_LABEL: Record<keyof Entitlements['limits'], string> = {
  maxActiveShares: 'Active shares',
  maxApiDocs: 'Hosted API docs',
  maxSeats: 'Seats',
};
const LIMIT_ORDER: (keyof Entitlements['limits'])[] = ['maxActiveShares', 'maxApiDocs', 'maxSeats'];

function fmtLimit(n: number): string {
  return n === -1 ? 'Unlimited' : String(n);
}

export function BillingPage() {
  const { entitlements: ctxEnt, reload } = useAuth();
  const [ent, setEnt] = useState<Entitlements | null>(ctxEnt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setEnt(await api.entitlements());
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Could not load billing.');
      }
    })();
  }, []);

  const e = ent ?? ctxEnt;

  const manage = async (kind: 'checkout' | 'portal') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { url } = await (kind === 'checkout' ? api.billingCheckout() : api.billingPortal());
      window.location.href = url;
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'entitlement' && err.code === 'billing_not_configured') {
        setNotice("Billing isn't configured on this server yet.");
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not open billing.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground">Your plan and subscription.</p>
      </div>

      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert tone="info">{notice}</Alert> : null}

      {!e ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Plan</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Tier</span>
                <Badge tone={e.tier !== 'free' ? 'default' : 'muted'}>{TIER_LABEL[e.tier] ?? e.tier}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className="font-medium capitalize">{e.status}</span>
              </div>
              {e.periodEndMs ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Renews / ends</span>
                  <span className="font-medium">{new Date(e.periodEndMs).toLocaleDateString()}</span>
                </div>
              ) : null}
              <div className="pt-2">
                {e.tier === 'free' ? (
                  <Button size="sm" loading={busy} onClick={() => void manage('checkout')}>
                    Upgrade to Pro
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" loading={busy} onClick={() => void manage('portal')}>
                    Manage subscription
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Features</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                {FEATURE_ORDER.map((key) => {
                  const on = e.features[key];
                  return (
                    <div key={key} className="flex items-center gap-2">
                      {on ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                      ) : (
                        <Minus className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className={on ? '' : 'text-muted-foreground'}>{FEATURE_LABEL[key]}</span>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-2 border-t pt-4">
                {LIMIT_ORDER.map((key) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{LIMIT_LABEL[key]}</span>
                    <span className="font-medium">{fmtLimit(e.limits[key])}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
