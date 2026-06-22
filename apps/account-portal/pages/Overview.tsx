/** Account overview — identity, email-verification state, and current plan. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from '../lib/ui.js';

const TIER_LABEL: Record<string, string> = { free: 'Free', pro: 'Pro', team: 'Teams', enterprise: 'Enterprise' };

export function OverviewPage() {
  const { account, entitlements, reload } = useAuth();
  const [resent, setResent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resend = async () => {
    setBusy(true);
    setResent(null);
    try {
      const r = await api.resendVerification();
      setResent(r.alreadyVerified ? 'Your email is already verified.' : 'Verification email sent — check your inbox.');
      if (r.alreadyVerified) await reload();
    } catch (e) {
      setResent(e instanceof ApiError ? e.message : 'Could not send the email.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">Manage your CodeStudio cloud account.</p>
      </div>

      {account && !account.emailVerified ? (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Your email isn't verified yet. Cloud writes (sync, publishing, teams) stay disabled until you confirm it.</span>
            <Button size="sm" variant="outline" loading={busy} onClick={() => void resend()}>
              Resend email
            </Button>
          </div>
          {resent ? <div className="mt-2 text-xs">{resent}</div> : null}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Email</span>
              <span className="font-medium">{account?.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Email status</span>
              {account?.emailVerified ? (
                <Badge tone="success">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Verified
                </Badge>
              ) : (
                <Badge tone="warning">
                  <AlertCircle className="mr-1 h-3 w-3" /> Unverified
                </Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className="font-medium capitalize">{account?.status}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Tier</span>
              <Badge tone={entitlements && entitlements.tier !== 'free' ? 'default' : 'muted'}>
                {entitlements ? (TIER_LABEL[entitlements.tier] ?? entitlements.tier) : '—'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className="font-medium capitalize">{entitlements?.status ?? '—'}</span>
            </div>
            {entitlements?.periodEndMs ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Renews / ends</span>
                <span className="font-medium">{new Date(entitlements.periodEndMs).toLocaleDateString()}</span>
              </div>
            ) : null}
            <div className="pt-2">
              <Link to="/billing">
                <Button size="sm" variant="outline">
                  Manage billing
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
