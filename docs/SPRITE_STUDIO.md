# Sprite Studio

An AI-powered 2D sprite creation / editing / export studio built into CodeStudio
("Meshy.ai for 2D sprites"). It is a **top-level surface** (route `/sprites`, like
the Design System Studio) with its own project selector — not a ProjectView tab
and not a plugin. Assets live **inside the game repo** under `.sprite-studio/`
(git-versioned, the source of truth); the SQLite tables (migration 196) are the
queryable operational mirror plus the generation-job / cost ledger.

Gated by `SPRITE_STUDIO_ENABLED` (default ON) — off unmounts the routes and hides
the `/sprites` nav entry.

## Layout in the repo

```
<game-repo>/.sprite-studio/
  project.json                 # name, style contract, references
  assets/<slug>/
    asset.json                 # manifest: category, tags, status, version lineage
    v001.png, v002.png, ...    # immutable versions (never overwritten)
  refs/...                     # moodboard / character-sheet references
<game-repo>/assets/sprites/    # export destination (configurable per project)
```

Job scratch (candidates before promotion) lives OUTSIDE the repo, under
`<dataDir>/sprite-studio/tmp/<jobId>/`, so nothing transient is ever committed.

## Architecture

- **Image generation** is a third provider client surface next to coder/indexer:
  `createImages` on `ProviderDefinition` (opt-in via `capabilities.supportsImageGen`),
  built per-wire by the provider engine (`packages/provider-engine/src/images/`).
  Image models are the provider rows discovered with `mode: 'image'` (families
  `gpt-image-*`, `dall-e-*`, gemini `*-image` / nano banana / imagen) — never a
  hardcoded version; a newer model surfaces automatically. Factory:
  `createImagesProvider(providerId, modelId)` in `@mcp/services`.
- **Pipeline roles** (`sprite-studio` pipeline): `image_gen` (generation model),
  `prompt_expander` (optional LLM that fuses intent + style into the final prompt),
  `vision` (consistency audits; falls back to `code-agent/vision`). Bound in
  Settings → Pipelines; failover via `resolveChain`.
- **Domain package** `@mcp/sprite-studio` (pure, unit-tested): repo manifests +
  path guard, RGBA processing ops (pngjs + image-q: quantize/dither, box downscale,
  bg-remove, outline, alpha cleanup), the job runner (queued → prompting →
  generating → postprocess → done/failed/cancelled, capability-filtered failover,
  staged candidates), candidate promotion, and export adapters (grid spritesheet +
  generic/Phaser atlas JSON).
- **Sprite worker** (`apps/http-api/workers/sprite-worker.ts` + `SpriteWorkerClient`)
  runs image processing off the main thread (no in-process fallback — a missing
  worker build is a hard, clearly-reported error).
- **Routes** `apps/http-api/server/routes/sprite-studio/*` (Hono): project get/init/
  settings/resync, asset + version CRUD (version bytes + worker-downscaled thumbs),
  generation enqueue + cancel + candidate preview + pick, and a long-lived per-project
  SSE stream (`sprite_job` / `sprite_variant_ready` / `sprite_job_done` /
  `sprite_job_failed`).
- **Agent tools** (`sprite_get_project`, `sprite_list_assets`, `sprite_generate`,
  `sprite_process`, `sprite_export`) let the chat agent drive the studio; registered
  when the flag is on and the project has a `.sprite-studio/` dir.

## Consistency and animation

Layered per the plan: (A) a compiled style block injected into every prompt,
(B) reference-image conditioning (edit-capable models), (C) deterministic
post-checks (palette distance / dimensions / alpha), (D) a manual vision-LLM
audit, (E) provenance replay. Animation is a first-class workflow: action and
direction metadata, multi-track timeline, onion skin, frame registration,
per-frame duration, GIF preview and engine-aware export. `sprite_animations` /
`sprite_frames` store references to immutable version rows, so editing one
timeline cell can create a child version without changing another clip.

## User flow

Open `/sprites` → pick a project → Initialize studio → create an asset → Generate
(variants stream in via SSE) → pick a variant (creates a version) → Edit (canvas:
brush/pencil/lasso/wand/fill + local adjustments) → Animate (create a semantic clip,
generate or arrange frames, preview and register) → Export (preview a write plan and
emit one selected animation, an asset, or a library scope into the game folder).
The chat agent uses the same generate/process/export services as the UI.
