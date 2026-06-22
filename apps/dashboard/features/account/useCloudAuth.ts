/**
 * Drives the cloud auth forms over `cloudCall` (which routes through Electron
 * main; tokens never touch the renderer). On success the main-process broadcast
 * flips `useCloudSession`, so the panel re-renders to the signed-in view. A login
 * that returns `twofa_required` surfaces a challenge step instead of an error.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Entitlements } from '@mcp/api-bus';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { CloudError } from '../../lib/cloud/cloud-errors.js';
import { useCloudSession } from '../../lib/cloud/use-cloud-session.js';

export function useCloudAuth() {
  const session = useCloudSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CloudError | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);

  useEffect(() => {
    if (session.state !== 'logged_in') {
      setEntitlements(null);
      return;
    }
    let alive = true;
    cloudCall('account.entitlements', undefined)
      .then((e) => alive && setEntitlements(e))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session.state]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof CloudError ? e : new CloudError('unknown', 0, String(e)));
    } finally {
      setBusy(false);
    }
  }, []);

  const signIn = useCallback(
    (email: string, password: string, turnstileToken?: string) =>
      run(async () => {
        try {
          await cloudCall('auth.login', { email, password, turnstileToken });
        } catch (e) {
          if (e instanceof CloudError && e.kind === 'twofa_required') {
            const ct = (e.details as { challengeToken?: string } | undefined)?.challengeToken;
            if (ct) {
              setChallengeToken(ct); // show the 2FA step, not an error
              return;
            }
          }
          throw e;
        }
      }),
    [run],
  );

  const signUp = useCallback(
    (email: string, password: string, turnstileToken?: string) =>
      run(() => cloudCall('auth.signup', { email, password, turnstileToken }).then(() => undefined)),
    [run],
  );

  const verify2fa = useCallback(
    (code: string) =>
      run(async () => {
        if (!challengeToken) return;
        await cloudCall('auth.challenge2fa', { challengeToken, code });
        setChallengeToken(null);
      }),
    [run, challengeToken],
  );

  const cancel2fa = useCallback(() => setChallengeToken(null), []);

  const [verifySent, setVerifySent] = useState(false);
  const resendVerification = useCallback(
    () =>
      run(async () => {
        await cloudCall('auth.resendVerification', undefined);
        setVerifySent(true);
      }),
    [run],
  );

  return { session, entitlements, busy, error, challengeToken, signIn, signUp, verify2fa, cancel2fa, resendVerification, verifySent };
}

export type CloudAuthHook = ReturnType<typeof useCloudAuth>;
