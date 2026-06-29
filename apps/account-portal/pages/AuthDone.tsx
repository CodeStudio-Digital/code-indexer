/** OAuth handoff landing. The Worker redirects here as /auth/done#handoff=<code>;
 *  we redeem it once for a session, scrub the token from history, then enter. */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { postLoginTarget } from '../lib/device.js';
import { Alert, Button, Card, CardContent, Spinner } from '../lib/ui.js';

export function AuthDonePage() {
  const navigate = useNavigate();
  const { reload } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // one-shot: a double redeem (StrictMode) would 400
    ran.current = true;
    const raw = window.location.hash.replace(/^#/, '');
    const handoff = new URLSearchParams(raw).get('handoff');
    // Scrub the one-time code from the URL/history IMMEDIATELY (before the network
    // call) so it can't leak via Referer, back-button, or a bookmark mid-flow.
    window.history.replaceState(null, '', '/');
    if (!handoff) {
      setError('Missing sign-in token. Please try signing in again.');
      return;
    }
    void (async () => {
      try {
        await api.oauthRedeem(handoff);
        await reload();
        // Return to the desktop bridge if this sign-in was launched from the app.
        navigate(postLoginTarget(), { replace: true });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Sign-in could not be completed.');
      }
    })();
  }, [navigate, reload]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      {error ? (
        <Card className="w-full max-w-sm">
          <CardContent className="space-y-3 pt-5">
            <Alert>{error}</Alert>
            <Button className="w-full" onClick={() => navigate('/login', { replace: true })}>
              Back to sign in
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Completing sign-in…
        </div>
      )}
    </div>
  );
}
