/**
 * Desktop "device login" bridge state. When the desktop opens the portal at
 * /device?port=<loopbackPort>, we stash the port so it survives the login redirect
 * (the user may need to sign in first), then the /device page mints a handoff and
 * returns to the desktop loopback. The host is always 127.0.0.1 (no open redirect).
 */
const DEVICE_PORT_KEY = 'cs_portal_device_port';

export function rememberDevicePort(port: string): void {
  try {
    sessionStorage.setItem(DEVICE_PORT_KEY, port);
  } catch {
    /* sessionStorage disabled — the /device page also accepts ?port= directly */
  }
}

export function peekDevicePort(): string | null {
  try {
    return sessionStorage.getItem(DEVICE_PORT_KEY);
  } catch {
    return null;
  }
}

export function clearDevicePort(): void {
  try {
    sessionStorage.removeItem(DEVICE_PORT_KEY);
  } catch {
    /* ignore */
  }
}

/** Where to go after a successful sign-in: the device bridge if one is pending,
 *  else the account home. Shared by the email/password and OAuth-redeem paths. */
export function postLoginTarget(): string {
  return peekDevicePort() ? '/device' : '/';
}

/** A valid loopback port (1–65535) or null. Guards the return redirect. */
export function parseLoopbackPort(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
