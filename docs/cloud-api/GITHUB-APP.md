# MegaBrainStudio GitHub App

The GitHub App is an optional agent identity. It never replaces a repository's
native SSH, credential helper, `.gitconfig`, `remote`, or `pushurl`. The desktop
uses the project identity by default and uses the managed identity only after an
explicit selection in the reviewed push dialog.

## GitHub App settings

- App ID: `4329188`
- Slug: `megabrainstudio`
- Callback URL:
  `https://codestudio-cloud-api.maiconspo6792.workers.dev/v1/github/callback`
- Recommended: enable **Request user authorization (OAuth) during installation**.
- If that option is disabled, set the Setup URL to:
  `https://codestudio-cloud-api.maiconspo6792.workers.dev/v1/github/setup`
- Repository permissions:
  - Contents: read and write
  - Pull requests: read and write
  - Metadata: read (GitHub supplies this permission)
- Webhooks are not required for this flow.
- Select **Any account** if customers must be able to install the App on their
  personal accounts or organizations.

The callback uses the temporary GitHub user token only to verify that the
installation returned by GitHub is accessible to that user. It is discarded
after verification and is never stored in D1.

## Cloudflare secrets

Run from `services/cloud-api`. Values are entered through Wrangler's secure
prompt; do not place them in `wrangler.jsonc`, shell history, or committed files.

```powershell
npx wrangler secret put GITHUB_APP_CLIENT_ID
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
npx wrangler secret put GITHUB_APP_STATE_SECRET
node scripts/set-github-app-key-secret.mjs C:\absolute\secure\path\megabrainstudio.private-key.pem
```

`GITHUB_APP_STATE_SECRET` may be omitted when the existing
`OAUTH_STATE_SECRET` is configured, but a separate secret is preferred for key
separation. The helper converts GitHub's PEM to a private RSA JWK and streams it
directly to Wrangler; it does not print or write the JWK.

## Release

Generate/check bindings, apply the D1 migration, validate a dry run, and then
deploy through the normal release process:

```powershell
pnpm types:check
npx wrangler d1 migrations apply codestudio-cloud --remote
npx wrangler deploy --dry-run
npx wrangler deploy
```

Remote migration and deploy are production mutations and should be run only in
the intended Cloudflare account/release window.

## Security boundary

- Long-lived GitHub App secrets exist only as Worker secrets.
- D1 stores account-installation links, hashes of 90-second one-use grants, and
  coarse usage events. It never stores GitHub tokens.
- A push grant is scoped to one account, installation, repository, and
  operation. The isolated local broker exchanges it once and keeps the resulting
  installation token out of Electron, Git remotes, process arguments, and logs.
- GitHub Enterprise hosts remain on native project authentication unless a
  separate, host-specific GitHub App deployment is configured.
