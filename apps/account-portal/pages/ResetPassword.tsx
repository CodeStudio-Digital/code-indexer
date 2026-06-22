/** Public reset-password page reached from the email link (/reset-password?token=).
 *  Validates that the two password fields match, then calls api.resetPassword and
 *  points the user back to /login. With no token the link is treated as invalid. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Cloud } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '../lib/ui.js';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const submitting = useRef(false);

  // Scrub the one-time token from the URL/history once captured (no Referer/history leak).
  useEffect(() => {
    if (token) window.history.replaceState(null, '', '/reset-password');
  }, [token]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || submitting.current) return;
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      submitting.current = false;
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
          {!token ? (
            <>
              <Alert>This link is invalid.</Alert>
              <Link to="/forgot" className="text-xs text-muted-foreground hover:underline">
                Request a new reset link
              </Link>
            </>
          ) : done ? (
            <>
              <p className="text-sm text-muted-foreground">Password updated.</p>
              <Button className="w-full" onClick={() => navigate('/login')}>
                Continue to sign in
              </Button>
            </>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              {error ? <Alert>{error}</Alert> : null}
              <div className="space-y-1">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" loading={busy}>
                Update password
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
