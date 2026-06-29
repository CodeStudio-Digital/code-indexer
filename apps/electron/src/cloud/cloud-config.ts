/** Cloud API base URL. Defaults to the deployed Worker; overridable for staging
 *  / local `wrangler dev` via the CODESTUDIO_CLOUD_URL env var. */
export function cloudBaseUrl(): string {
  return (process.env.CODESTUDIO_CLOUD_URL || 'https://codestudio-cloud-api.maiconspo6792.workers.dev').replace(/\/$/, '');
}

/** Web portal base URL — used by the device-login bridge (the desktop opens the
 *  portal in the browser; the user signs in there and is handed back via the
 *  loopback). Defaults to the live Pages deployment; override via CODESTUDIO_PORTAL_URL. */
export function portalUrl(): string {
  return (process.env.CODESTUDIO_PORTAL_URL || 'https://codestudio-account-portal.pages.dev').replace(/\/$/, '');
}
