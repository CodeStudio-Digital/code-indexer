/** Security — email verification, password reset link, two-factor (enroll/confirm
 *  /disable), data export, and account deletion. The API exposes no "is 2FA on?"
 *  flag, so both the enable and disable flows are always offered. */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '../lib/ui.js';

export function SecurityPage() {
  const { account, reload } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Security</h1>
        <p className="text-sm text-muted-foreground">Protect your account.</p>
      </div>

      <EmailCard verified={!!account?.emailVerified} onVerified={reload} />
      <PasswordCard email={account?.email ?? null} />
      <TwoFactorCard />
      <DataCard />
      <DangerZoneCard />
    </div>
  );
}

function EmailCard({ verified, onVerified }: { verified: boolean; onVerified: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const resend = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api.resendVerification();
      if (r.alreadyVerified) {
        setDone('Your email is already verified.');
        await onVerified();
      } else {
        setDone('Verification email sent — check your inbox.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send the email.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>Verify your address to unlock cloud writes (sync, publishing, teams).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Status</span>
          {verified ? (
            <Badge tone="success">
              <CheckCircle2 className="mr-1 h-3 w-3" /> Verified
            </Badge>
          ) : (
            <Badge tone="warning">
              <AlertTriangle className="mr-1 h-3 w-3" /> Unverified
            </Badge>
          )}
        </div>
        {!verified ? (
          <Button size="sm" variant="outline" loading={busy} onClick={() => void resend()}>
            Resend verification
          </Button>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        {done ? <p className="text-xs text-muted-foreground">{done}</p> : null}
      </CardContent>
    </Card>
  );
}

function PasswordCard({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const sendLink = async () => {
    if (!email) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.forgotPassword(email);
      setDone('Check your inbox.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send the email.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Password changes are done through an emailed reset link, not in this portal.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" variant="outline" loading={busy} disabled={!email} onClick={() => void sendLink()}>
          Email me a reset link
        </Button>
        {error ? <Alert>{error}</Alert> : null}
        {done ? <p className="text-xs text-muted-foreground">{done}</p> : null}
      </CardContent>
    </Card>
  );
}

function TwoFactorCard() {
  // enroll flow
  const [enroll, setEnroll] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  // disable flow
  const [dPassword, setDPassword] = useState('');
  const [dCode, setDCode] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disableDone, setDisableDone] = useState<string | null>(null);

  const startEnroll = async () => {
    setEnrollBusy(true);
    setEnrollError(null);
    setRecovery(null);
    try {
      setEnroll(await api.twofaEnroll());
    } catch (e) {
      setEnrollError(e instanceof ApiError ? e.message : 'Could not start enrollment.');
    } finally {
      setEnrollBusy(false);
    }
  };

  const confirmEnroll = async () => {
    setEnrollBusy(true);
    setEnrollError(null);
    try {
      const r = await api.twofaConfirm(code.trim());
      setRecovery(r.recoveryCodes);
      setEnroll(null);
      setCode('');
    } catch (e) {
      setEnrollError(e instanceof ApiError ? e.message : 'Could not confirm the code.');
    } finally {
      setEnrollBusy(false);
    }
  };

  const disable = async () => {
    setDisableBusy(true);
    setDisableError(null);
    setDisableDone(null);
    try {
      await api.twofaDisable(dPassword, dCode.trim());
      setDisableDone('Two-factor authentication disabled.');
      setDPassword('');
      setDCode('');
    } catch (e) {
      setDisableError(e instanceof ApiError ? e.message : 'Could not disable 2FA.');
    } finally {
      setDisableBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <CardTitle>Two-factor authentication</CardTitle>
        </div>
        <CardDescription>Add a time-based code from an authenticator app on top of your password.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Enable */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Enable</h3>
          {recovery ? (
            <Alert tone="warning">
              <div className="space-y-2">
                <div className="font-medium">Two-factor is on. Save these recovery codes now — they won't be shown again.</div>
                <ul className="grid grid-cols-2 gap-1 font-mono text-xs">
                  {recovery.map((c) => (
                    <li key={c} className="select-all">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </Alert>
          ) : !enroll ? (
            <Button size="sm" loading={enrollBusy} onClick={() => void startEnroll()}>
              Enable 2FA
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Add this secret to your authenticator app, then enter the generated 6-digit code.</p>
              <code className="block select-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm break-all">
                {enroll.secret}
              </code>
              <div className="space-y-1">
                <Label htmlFor="twofa-code">Authentication code</Label>
                <Input
                  id="twofa-code"
                  inputMode="numeric"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <Button size="sm" loading={enrollBusy} disabled={code.trim().length === 0} onClick={() => void confirmEnroll()}>
                Confirm
              </Button>
            </div>
          )}
          {enrollError ? <Alert>{enrollError}</Alert> : null}
        </div>

        {/* Disable */}
        <div className="space-y-3 border-t border-border pt-6">
          <h3 className="text-sm font-medium">Disable</h3>
          <p className="text-sm text-muted-foreground">Enter your current password and a code from your authenticator to turn 2FA off.</p>
          <div className="space-y-1">
            <Label htmlFor="twofa-pw">Current password</Label>
            <Input
              id="twofa-pw"
              type="password"
              autoComplete="current-password"
              value={dPassword}
              onChange={(e) => setDPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="twofa-disable-code">Authentication code</Label>
            <Input
              id="twofa-disable-code"
              inputMode="numeric"
              placeholder="123456"
              value={dCode}
              onChange={(e) => setDCode(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            loading={disableBusy}
            disabled={dPassword.length === 0 || dCode.trim().length === 0}
            onClick={() => void disable()}
          >
            Disable 2FA
          </Button>
          {disableError ? <Alert>{disableError}</Alert> : null}
          {disableDone ? <p className="text-xs text-muted-foreground">{disableDone}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function DataCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const exportData = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const data = await api.exportAccount();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'codestudio-account.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone('Your data has been downloaded.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not export your data.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>Download a JSON copy of your account.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" variant="outline" loading={busy} onClick={() => void exportData()}>
          <Download className="mr-1 h-4 w-4" /> Export account data
        </Button>
        {error ? <Alert>{error}</Alert> : null}
        {done ? <p className="text-xs text-muted-foreground">{done}</p> : null}
      </CardContent>
    </Card>
  );
}

function DangerZoneCard() {
  const [revealed, setRevealed] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!confirm('Permanently delete your account? This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(password);
      // tokens are cleared by the client on success — bounce to login.
      window.location.assign('/login');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete your account.');
      setBusy(false);
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>Deleting your account is permanent and removes all cloud data.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!revealed ? (
          <Button size="sm" variant="destructive" onClick={() => setRevealed(true)}>
            Delete account
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="delete-pw">Confirm your password</Label>
              <Input
                id="delete-pw"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="destructive" loading={busy} disabled={password.length === 0} onClick={() => void remove()}>
                Permanently delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRevealed(false);
                  setPassword('');
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {error ? <Alert>{error}</Alert> : null}
      </CardContent>
    </Card>
  );
}
