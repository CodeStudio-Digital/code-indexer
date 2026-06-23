# Pre-warmed base image for Node-stack sandboxes (React/Vue/Vite et al).
#
# Why pre-warm? `npm create vite@latest` + `npm install` against a cold
# npm cache can take 60+ seconds. Baking the common tarballs into the
# image knocks that down to single-digit seconds for the happy path and
# keeps the LLM preview loop interactive.
#
# Build:
#   podman build -t mcp-sandbox-node:20-py docker/sandbox-node
#   # or: docker build -t mcp-sandbox-node:20-py docker/sandbox-node
#
# When to rebuild:
#   - New stack added that needs additional deps (update ANCHOR_DEPS).
#   - Node/npm base version bump.
#
# Notes:
#   - Debian bookworm-slim (glibc) is required because Cloudflare's
#     `workerd` binary — which ships inside the wrangler package as
#     `@cloudflare/workerd-linux-64` — is built for glibc ONLY. There
#     is no musl build. Alpine caused `spawn workerd ENOENT` on every
#     `cf-worker` scaffold. Frontend stacks (react-ts/vue-ts/angular/
#     vite-api) work equally well on Debian, so we keep a single image.
#   - We do NOT set `USER` here. Hardening (non-root + cap_drop + seccomp)
#     lives in Phase 5; for now the container stays root inside its own
#     pid+net namespace which matches the v1 threat model.
#   - The cached tarballs are in `/root/.npm`. `npm install` will reuse
#     them automatically when package.json references matching versions.

FROM node:20-bookworm-slim

# System tooling the CLI driver and scaffolders expect. `iproute2` ships
# the `ss` command used to probe dev-server readiness in-container.
# `ca-certificates` is required for `npm install` TLS against the
# registry — Alpine shipped it in the base image, Debian-slim does not.
# Python is included so agents can run ad-hoc scripts via `run_command`
# (e.g. `python -` with the script body on stdin). `python3-venv` is a
# separate Debian package that `python3 -m venv` requires; without it
# venv creation fails with a confusing "ensurepip is not available".
# `python-is-python3` creates the `/usr/bin/python` alias — the
# command-synth allowlist and diagnostics tool both invoke `python` bare,
# so Debian's "python3-only" default would silently break those paths.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      bash \
      tini \
      iproute2 \
      ca-certificates \
      python3 \
      python3-pip \
      python3-venv \
      python-is-python3 \
 && rm -rf /var/lib/apt/lists/*

# Primer npm config — no audits in CI-style runs, reasonable timeouts.
RUN npm config set fund false \
 && npm config set audit false \
 && npm config set update-notifier false

# Pre-warm the cache with the packages every Vite+React/Vue scaffold
# drags in. Keeping this as a separate RUN layer means adding a stack
# later only invalidates this layer, not the base tooling.
#
# We `npm install` into a throwaway dir and then remove `node_modules`
# — the point is to populate `/root/.npm`, not to ship a vendor dir.
WORKDIR /tmp/primer
# --legacy-peer-deps: this layer only warms /root/.npm with tarballs; it
# doesn't ship a node_modules. Strict peer resolution would require
# pinning the exact plugin-react / plugin-vue versions that match vite 8
# at build time, which churns fast. The primer only needs the packages
# cached; the scaffolders then do their own clean install at runtime
# with THEIR own (correct) peer sets, where npm defaults to strict
# resolution and will flag any real conflict.
RUN printf '{"name":"primer","version":"0.0.0","private":true}\n' > package.json \
 && npm install --no-save --legacy-peer-deps \
      vite@^8 \
      @vitejs/plugin-react@^4 \
      @vitejs/plugin-vue@^5 \
      react@^19 \
      react-dom@^19 \
      vue@^3 \
      typescript@^5.9 \
      hono@^4.12 \
      @hono/vite-dev-server@^0.25 \
      wrangler@^4.83 \
      @cloudflare/workers-types@^4.2026 \
 && rm -rf /tmp/primer

# The sandbox workdir. We do TWO things here:
#   1. `mkdir -p /app` — explicit so the directory exists even on
#      container runtimes that validate `-w /app` on `run` strictly
#      (Podman 4.x does; Docker is permissive and auto-creates).
#   2. `chown 1000:1000 /app` — makes /app writable when the container
#      runs as the non-root `node` user (uid 1000 in the node:20-alpine
#      base image). Without this, scaffolder writes fail with EACCES
#      the moment `npm create vite` tries to put files in /app.
#
# Doing both in one RUN keeps the layer small. `WORKDIR` sets the
# default cwd for subsequent instructions and for containers that don't
# pass `-w` explicitly.
RUN mkdir -p /app && chown 1000:1000 /app
WORKDIR /app

# Keep the main process alive forever. The driver launches scaffolders
# and the dev server via `docker exec`, so pid 1 just needs to not exit.
# `tini` reaps zombies from nohup'd dev-server children. On Debian the
# binary is at /usr/bin/tini (Alpine used /sbin/tini).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["tail", "-f", "/dev/null"]
