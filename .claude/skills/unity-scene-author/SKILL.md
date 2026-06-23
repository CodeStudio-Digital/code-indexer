---
name: unity-scene-author
description: Build or modify content in the active Unity scene via the scene-analyzer MCP server — primitives, prefab instances, lights, transforms, properties — using a single Undo group so the user can revert with one Ctrl+Z. Triggers on phrases like "monte uma cena", "adicione uma luz", "crie um prédio", "instancie o prefab X", "build a scene", "spawn N trees", "place a directional light".
---

# Unity scene authoring

Run when the user wants to **create or modify** content in the open Unity scene. Always preserve a clean Undo history and prefer one batched changeset over many sequential calls.

## Required tool prefix

Tools are registered behind the `unity-editor` MCP server and appear as `ext_unity_editor__*`. Use the bare tool name in this skill; prefix appropriately when calling.

## Step 0 — context

1. `get_project_meta` — render pipeline matters when picking materials/shaders.
2. `read_hierarchy` — see what already exists; pick parents for new objects; avoid duplicate names.
3. `list_assets` — filter by type (`Prefab`, `Material`, `Mesh`, `AudioClip`) and folder when the user references "the trees" or "the wall material". Don't guess GUIDs.

## Step 1 — plan

Translate the user's natural-language request into an op list. Each op has the shape `{ "kind": <kind>, "args": { ... } }`. Available `kind` values:

- **Create**: `create_primitive`, `create_empty`, `instantiate_prefab`, `create_light`, `create_camera`, `create_audio_source`, `create_particle_system`, `create_volume`
- **Modify**: `set_transform`, `set_camera_props`, `set_property`, `add_component`, `set_material`, `parent_object`, `delete_object`
- **Post-processing & render**: `add_post_effect`, `set_post_effect_property`, `apply_color_grading`, `set_render_settings`

Group related ops in one changeset using **labels and refs**. Any op can carry a top-level `label` string; the resulting instanceId is stored under that label and any later op in the same batch can reference it via `{ "ref": "<label>" }` anywhere in its args. Example: create an empty parent, then primitives that point at it via `parent: { ref: "houseRoot" }`:

```json
{
  "name": "House skeleton",
  "ops": [
    { "kind": "create_empty", "label": "houseRoot", "args": { "name": "House" } },
    { "kind": "create_primitive", "args": { "kind": "Plane", "parent": { "ref": "houseRoot" }, "scale": [4, 1, 4] } },
    { "kind": "create_primitive", "args": { "kind": "Cube",  "parent": { "ref": "houseRoot" }, "position": [0, 1, 2], "scale": [4, 2, 0.1] } }
  ]
}
```

This avoids the old "create parent → read_hierarchy → create children" round-trip dance.

When the count is **above ~50 ops** or the user asked for a randomised layout, pre-compute every position/rotation deterministically (seeded RNG conceptually) before emitting the changeset.

## Step 2 — preview

Call `apply_changeset` with `preview: true` first when the changeset is non-trivial (>5 ops, or any deletion). The response lists what would happen without mutating. Show that summary to the user, get explicit "go ahead", then re-emit with `preview: false`.

For a single tiny op (one light, one cube), skip the preview — the dedicated tool (`create_light`, `create_primitive`) is fine and equally undoable.

## Step 3 — apply

Emit `apply_changeset` with a meaningful `name` (becomes the Undo group label, visible in **Edit → Undo \<name\>**). The plugin enforces `MaxBatchOps` (default 500) — split into multiple changesets if needed and tell the user to undo each in turn.

## Step 4 — verify

After authoring, run `validate_scene` once. If `analyze_performance` was concerning before, re-run it to confirm you didn't regress.

If you created visible content, optionally `select_object` the most relevant root so the user sees it in the Hierarchy and SceneView.

## Coordinate system & defaults

- World up is `+Y`. Forward is `+Z`. Unity is left-handed.
- Vector inputs accept `[x, y, z]` or `{ "x":..., "y":..., "z":... }`.
- Rotations: `[x,y,z]` = euler degrees; `[x,y,z,w]` or `{x,y,z,w}` = quaternion.
- Colors: hex string `"#rrggbb"`, array `[r,g,b]` or `[r,g,b,a]`, or object `{r,g,b,a}` with components in 0..1.
- If parent isn't given, the object is created at the scene root.
- Default scale is `[1,1,1]`. Don't pass scale unless the user asked.

## Look & feel: post-processing and render settings

When the user asks to "ajustar a cor da cena", "deixar mais cinematográfico", "adicionar bloom", "mudar o mood":

1. Check the render pipeline first — `get_project_meta`. Volume/post-fx tools require **URP or HDRP**; on Built-in pipeline, `add_post_effect` returns an error and the user needs to either install URP/HDRP or accept that those tweaks aren't possible.
2. Find or create the global Volume:
   - `read_hierarchy` → look for an existing GameObject with `UnityEngine.Rendering.Volume` component (the componentTypes list includes it).
   - If none, `create_volume` (creates a profile asset under `Assets/Settings/`).
3. For **color grading** (most common request — exposure, contrast, saturation, hue, color filter), use `apply_color_grading` — it adds ColorAdjustments and sets all knobs in one call.
4. For other effects (Bloom, Tonemapping, Vignette, DepthOfField, MotionBlur, ChromaticAberration, FilmGrain, WhiteBalance, …): `add_post_effect` first (idempotent), then `set_post_effect_property` for each parameter. `effect` is the type name; `property` is the field name on that effect (e.g. Bloom has `intensity`, `threshold`, `scatter`, `tint`).
5. For **scene-wide rendering** (ambient lighting, fog, skybox material): `set_render_settings`. Note: RenderSettings is static in Unity, so per-tweak undo is best-effort — warn the user if you change ambient/fog so they know it'll persist with the scene save.

Common combos worth memorising:

- **"Cena mais escura/dramática"**: `apply_color_grading` with `exposure: -0.5, contrast: 20, saturation: -10` + `add_post_effect Vignette` then `set_post_effect_property Vignette.intensity = 0.4`.
- **"Cena mais cinematográfica"**: add Tonemapping with `mode: "ACES"`, add Bloom with `intensity: 0.6` and `threshold: 1.1`, add slight FilmGrain.
- **"Cena de neblina"**: `set_render_settings { fog: true, fogColor: "#a0a8b0", fogMode: "ExponentialSquared", fogDensity: 0.02 }`.

## Analysis-guided placement (mesh analytics)

When the user wants to **place things on specific parts of a mesh** — "spawn 15 lamp posts on the sidewalk", "put waypoints only on the road", "scatter trees on the platform but keep them away from the edges" — chain the read-only mesh analytics tools before authoring:

1. **Find the surface** via `mesh_detect_planes(instanceId)` (or `mesh_detect_smooth_regions` for organic geometry). Each returned region carries an `orientationLabel` + a `classification` heuristic (`ground_candidate` / `platform_candidate` / `wall_candidate` / `door_or_window_candidate` / `ceiling_candidate`). Filter the response to the region(s) the user described.
2. **(Optional) confirm visually** with `render_region_highlight(regionId)` — the chosen region appears in orange. Skip when you're confident from the classification alone.
3. **Resolve to coordinates** via `mesh_sample_points_on_region(regionId, count|spacing, inset, distribution="poisson_disk")`. `inset` (metres) keeps points away from the region's border — use it whenever the user says "not on the edge" / "longe da calçada" / "fora do meio-fio".
4. **Author** the placements: build a single `apply_changeset` with one `instantiate_prefab` / `create_primitive` per sample point, passing `position` from the sample and (optionally) using the sample's surface `normal` to align the object's `up`. The whole batch becomes one Ctrl+Z group.

Example sequence (15 lamp posts on a sidewalk):

```
mesh_detect_planes(sidewalk)
  → pick region whose classification == "platform_candidate"
mesh_sample_points_on_region(thatRegionId, count=15, inset=0.5, distribution="poisson_disk")
  → returns 15 (position, normal) pairs
apply_changeset({ name: "Place lamp posts", ops: [
  { kind: "instantiate_prefab", args: { prefab: "<lamp_post>", position: pts[0].position }, label: "lamp_0" },
  ... (one per point)
]})
```

For **edge-following placement** (e.g. bollards along the kerb, signs along a rail) use `mesh_detect_sharp_edges` instead and walk `vertexPositionsWorld` at fixed arc-length intervals — chains don't have a `sample_points` tool because their data is already vertex-ordered.

For **repeated structural patterns** (placing identical objects along trilhos, sticking decals on each window of a façade in a fileira), use `mesh_detect_parallel_chains` first — it identifies the regular spacing so you can replicate it without measuring by hand.

## Hard limits

- Refuse to call write tools if `WRITE_DISABLED` is returned — user needs to flip "Allow writes" in **Window → Scene Analyzer**.
- `delete_object` refuses subtrees with >8 children unless `force: true`. Ask the user to confirm before passing `force`.
- Don't touch project settings, build settings, layers, or tags via `set_property` — those are out of the scope of this MCP server.
- Never auto-save the scene. The user owns persistence (Ctrl+S).

## Reporting

After every changeset, report: ops applied, any non-fatal warnings, and the resulting top-level instanceIds (so a follow-up tweak can target them). Mention "Ctrl+Z reverts the entire \<name\>" so the user knows the undo is atomic.
