/** Email verification landing — hit from the link we email (/verify-email?token=).
 *  Redeems the token once on mount, then offers a way back into the account. */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { Alert, Button, Card, CardContent, Spinner } from '../lib/ui.js';

export function VerifyEmailPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState<'pending' | 'done'>('pending');
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // one-shot: a double redeem (StrictMode) would fail
    ran.current = true;
    // Scrub the one-time token from the URL/history (no Referer/history leak).
    if (typeof window !== 'undefined') window.history.replaceState(null, '', '/verify-email');
    if (!token) {
      setError('Missing verification token. Please use the link from your email.');
      return;
    }
    void (async () => {
      try {
        await api.verifyEmail(token);
        setStatus('done');
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Your email could not be verified.');
      }
    })();
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4 pt-5">
          {error ? (
            <>
              <Alert>{error}</Alert>
              <Link to="/login" className="block text-center text-sm text-muted-foreground hover:underline">
                Back to sign in
              </Link>
            </>
          ) : status === 'done' ? (
            <>
              <div className="flex items-center gap-2">
                <MailCheck className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">Your email is verified.</span>
              </div>
              <Button className="w-full" onClick={() => navigate('/', { replace: true })}>
                Go to your account
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Verifying your email…
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
