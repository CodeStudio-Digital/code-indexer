# Vendored draw.io webapp (self-hosted embed)

This folder holds the **static draw.io editor webapp** that CodeStudio serves at
`/drawio/*` (`mcp://app/drawio/*` in the packaged Electron app) for the diagram
capability. Self-hosting is required: the packaged CSP blocks remote iframes
(`frame-src 'self' mcp://app http://localhost:*`), and self-hosting keeps the
feature working offline.

## How to install

```
pnpm drawio:fetch
```

This downloads a pinned [jgraph/drawio](https://github.com/jgraph/drawio) release
and extracts `src/main/webapp/` into this directory. After it runs, `index.html`
(plus `js/`, `styles/`, `images/`, `shapes/`, `stencils/`, `math/`, …) live here.

Override the version with `DRAWIO_VERSION=<tag>` (without the leading `v`).

## How it's served

- Dev (browser): the dashboard iframes `/drawio/index.html?embed=1&proto=json…`,
  proxied to the backend by Vite (`apps/dashboard/vite.config.ts`).
- Electron: the iframe loads `mcp://app/drawio/index.html?…`, routed in-process
  to the Hono app (`apps/http-api/server/routes/drawio-static.ts`).
- Packaged: electron-builder copies this folder to `resources/drawio`
  (`extraResources` in `apps/electron/electron-builder.json`); the route resolves
  it via `process.resourcesPath`.

When this folder is empty, the route returns a friendly placeholder instead of a
blank iframe.

> Only `VENDOR.md` is committed; the downloaded assets are git-ignored — run
> `pnpm drawio:fetch` after cloning.
