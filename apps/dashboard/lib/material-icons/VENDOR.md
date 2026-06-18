# Vendored: Material Icon Theme

`svg/*.svg` and `manifest.generated.json` are **generated** — do not edit by hand.

- Source: [`material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme) (MIT), pinned in `scripts/fetch-material-icons.mjs` (`DEFAULT_VERSION`).
- Refresh: `pnpm icons:fetch` (downloads the pinned npm tarball, copies only the *reachable* icons, regenerates the trimmed manifest).
- Bump version: `MATERIAL_ICONS_VERSION=x.y.z pnpm icons:fetch`, then update `DEFAULT_VERSION`.

`resolve.ts` loads the SVGs via `import.meta.glob('./svg/*.svg', { query: '?url' })` so they
emit as hashed `/assets/*` (Electron-safe under `mcp://app`). `components/FileIcon.tsx`
renders them via `<img>`, falling back to the lucide glyphs in `lib/file-icon.tsx`.
