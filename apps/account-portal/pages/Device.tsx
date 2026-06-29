/**
 * Desktop device-login bridge. The desktop opens /device?port=<loopbackPort> in the
 * browser. If the user isn't signed in we send them to /login (the port is stashed
 * and we return here afterwards). Once signed in, we mint a one-time handoff and
 * redirect to the desktop loopback (127.0.0.1:<port>/cb), which redeems it — the
 * same machinery as OAuth, but reachable via email/password too.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, tokens } from '../lib/api.js';
import { rememberDevicePort, peekDevicePort, clearDevicePort, parseLoopbackPort } from '../lib/device.js';
import { Alert, Button, Card, CardContent, Spinner } from '../lib/ui.js';

export function DevicePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // one-shot (StrictMode + a one-time handoff)
    ran.current = true;
    const port = parseLoopbackPort(params.get('port') ?? peekDevicePort());
    if (!port) {
      setError('Missing or invalid device port. Re-launch sign-in from the desktop app.');
      return;
    }
    if (!tokens.isLoggedIn) {
      rememberDevicePort(String(port)); // survive the login redirect; return here after
      navigate('/login', { replace: true, state: { from: '/device' } });
      return;
    }
    void (async () => {
      try {
        const { handoff } = await api.createHandoff();
        clearDevicePort();
        // Top-level navigation to the loopback (not a fetch → no CORS). The desktop
        // captures the handoff and redeems it; this tab can then be closed.
        window.location.href = `http://127.0.0.1:${port}/cb?handoff=${encodeURIComponent(handoff)}`;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Could not complete desktop sign-in.');
      }
    })();
  }, [navigate, params]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      {error ? (
        <Card className="w-full max-w-sm">
          <CardContent className="space-y-3 pt-5">
            <Alert>{error}</Alert>
            <Button className="w-full" onClick={() => navigate('/', { replace: true })}>
              Go to account
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Returning you to the CodeStudio app…
        </div>
      )}
    </div>
  );
}
