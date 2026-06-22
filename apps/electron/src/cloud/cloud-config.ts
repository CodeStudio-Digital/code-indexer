/** Cloud API base URL. Defaults to the deployed Worker; overridable for staging
 *  / local `wrangler dev` via the CODESTUDIO_CLOUD_URL env var. */
export function cloudBaseUrl(): string {
  return (process.env.CODESTUDIO_CLOUD_URL || 'https://codestudio-cloud-api.maiconspo6792.workers.dev').replace(/\/$/, '');
}
