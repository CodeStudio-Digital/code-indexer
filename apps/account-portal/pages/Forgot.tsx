/** Public password-reset request (/forgot). Posts the email to
 *  api.forgotPassword, which ALWAYS succeeds (no account enumeration) — so on
 *  success we hide the form and show a neutral message regardless of whether the
 *  address has an account. Only network failures surface as an Alert. */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Cloud } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../lib/ui.js';

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-primary" />
            <CardTitle>Reset your password</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}

          {sent ? (
            <>
              <p className="text-sm text-muted-foreground">If that email has an account, a reset link is on its way.</p>
              <Link to="/login" className="block text-xs text-muted-foreground hover:underline">
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Enter your email and we’ll send you a link to reset your password.</p>
              <form onSubmit={onSubmit} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <Button type="submit" className="w-full" loading={busy}>
                  Send reset link
                </Button>
              </form>
              <Link to="/login" className="block text-xs text-muted-foreground hover:underline">
                Back to sign in
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
