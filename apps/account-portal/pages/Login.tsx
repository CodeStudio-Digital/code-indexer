/** Sign-in / create-account. OAuth (Google/GitHub/Microsoft) redirects the whole
 *  page to the Worker (?flow=portal) which returns to /auth/done#handoff=. Email +
 *  password posts directly; a 2FA challenge is handled inline. */
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cloud } from 'lucide-react';
import { api, ApiError, type ProviderId } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { TurnstileWidget, turnstileEnabled } from '../lib/turnstile.js';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../lib/ui.js';

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
  { id: 'microsoft', label: 'Microsoft' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const { reload } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [twofa, setTwofa] = useState<{ challengeToken: string } | null>(null);
  const [code, setCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [resetNonce, setResetNonce] = useState(0);
  const submitting = useRef(false); // synchronous guard against rapid double Enter

  const finish = async () => {
    await reload();
    navigate('/', { replace: true });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    if (!twofa && turnstileEnabled && !turnstileToken) {
      setError('Please complete the verification challenge.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (twofa) {
        await api.challenge2fa(twofa.challengeToken, code.trim());
        await finish();
        return;
      }
      if (mode === 'signup') {
        await api.signup(email.trim(), password, confirm, turnstileToken ?? undefined);
      } else {
        await api.login(email.trim(), password, turnstileToken ?? undefined);
      }
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'twofa_required') {
        const ct = (err.details as { challengeToken?: string } | undefined)?.challengeToken;
        if (ct) {
          setTwofa({ challengeToken: ct });
          setError(null);
          return;
        }
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      submitting.current = false;
      setBusy(false);
      // Turnstile tokens are single-use server-side — re-challenge after each attempt.
      setTurnstileToken(null);
      setResetNonce((n) => n + 1);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-primary" />
            <CardTitle>{twofa ? 'Two-factor code' : mode === 'login' ? 'Sign in to CodeStudio' : 'Create your account'}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}

          {twofa ? (
            <form onSubmit={onSubmit} className="space-y-3">
              <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app (or a recovery code).</p>
              <Input
                autoFocus
                inputMode="numeric"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button type="submit" className="w-full" loading={busy}>
                Verify
              </Button>
              <button type="button" className="w-full text-xs text-muted-foreground hover:underline" onClick={() => setTwofa(null)}>
                Back
              </button>
            </form>
          ) : (
            <>
              <div className="space-y-2">
                {PROVIDERS.map((p) => (
                  <Button
                    key={p.id}
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      window.location.href = api.oauthStartUrl(p.id);
                    }}
                  >
                    Continue with {p.label}
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>

              <form onSubmit={onSubmit} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                {mode === 'signup' ? (
                  <div className="space-y-1">
                    <Label htmlFor="confirm">Confirm password</Label>
                    <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                  </div>
                ) : null}
                {turnstileEnabled ? <TurnstileWidget onToken={setTurnstileToken} resetNonce={resetNonce} /> : null}
                <Button type="submit" className="w-full" loading={busy}>
                  {mode === 'login' ? 'Sign in' : 'Create account'}
                </Button>
              </form>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <button type="button" className="hover:underline" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}>
                  {mode === 'login' ? 'Create an account' : 'I already have an account'}
                </button>
                {mode === 'login' ? (
                  <a href="/forgot" className="hover:underline">
                    Forgot password?
                  </a>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
