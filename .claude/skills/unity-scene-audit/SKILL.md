---
name: unity-scene-audit
description: Read-only audit of the active Unity scene via the scene-analyzer MCP server. Use when the user asks to diagnose performance issues, find broken references, list expensive parts of a scene, or generally understand what is loaded — without making any changes. Triggers on phrases like "auditar a cena", "perf da cena", "o que tem na cena", "validar referências", "audit scene", "scene perf review".
---

# Unity scene audit

Run when the user wants to understand or diagnose the open Unity scene. Read-only; never call write tools.

## Required tool prefix

The tools live behind the MCP server registered as `unity-editor`, so they appear as `ext_unity_editor__*`. Examples below use the bare tool name; prefix appropriately when calling.

## Pre-flight

Confirm the MCP server is reachable. Call `get_project_meta` first — it doubles as a health check and tells you the render pipeline (Built-in / URP / HDRP) and the active build target.

## Audit flow

1. `get_project_meta` — Unity version and render pipeline.
2. `read_hierarchy` — flat list of GameObjects, parent-child edges, component types. Use to gauge scene size.
3. `analyze_performance` (with `maxIssues: 200` by default) — geometry, draw-call grouping, lighting, script cost, hierarchy depth.
4. `validate_scene` — broken references, required-field violations, missing scripts.

## Reporting

Group findings by severity (Error → Warning → Info), then by category. For each issue, include the GameObject path so the user can `select_object` later (or hand it off to the author flow).

Always end with the **top 5 actionable items**, ordered by impact × ease-of-fix. Examples of high-impact / low-effort: marking obviously static renderers as `Static`, deduplicating identical materials, replacing realtime lights with mixed/baked when shadows allow.

## Mesh analytics (geometric introspection)

When the user wants to understand the **structure of a specific mesh** — "where is the sidewalk border", "find the walls of this building", "which planes face up", "are these rails parallel" — switch from scene-level audit to mesh-level analytics. All 8 tools are read-only.

1. `mesh_inspect_submeshes(instanceId)` — list submeshes with material name, triangle count, bounds. Use when the artist already separated geometry by intent (e.g. "Floor" / "Walls" / "DoorFrame" submeshes).
2. `mesh_detect_sharp_edges(instanceId, dihedralAngleMin=30)` — finds visible contours (sidewalk perimeters, building corners, stair noses). Returns polylines sorted longest-first. The longest chain usually traces the dominant outline.
3. `mesh_detect_planes(instanceId)` — RANSAC into dominant planes with orientation labels (`horizontal_up` / `vertical:bearing`) and a heuristic classification (`ground_candidate` / `platform_candidate` / `wall_candidate` / `door_or_window_candidate` / `ceiling_candidate`).
4. `mesh_detect_smooth_regions(instanceId, frontierAngleTolerance=15)` — complement of sharp edges; flood-fills across non-sharp adjacencies. Use for organic surfaces (terrain, sculpted props) where plane detection wouldn't fit.
5. `mesh_detect_parallel_chains(instanceId)` — clusters edge chains that run parallel with regular spacing. Detects trilhos, grades, escadas, janelas em fileira.
6. `render_object_views(instanceId, views=["iso","top"], overlay="lit_default"|"wireframe"|"submesh_color")` — frames the GameObject in an off-screen camera. `submesh_color` reveals submesh layout; `wireframe` exposes geometry density.
7. `render_region_highlight(regionId, view="iso")` — re-renders the object with one region overlaid in orange (polyline for edges/parallel groups, translucent face for planes/submeshes/smooth patches). The visual loop-closer: detector returns a regionId → you call this to see it.
8. `mesh_sample_points_on_region(regionId, count|spacing, inset, distribution)` — generates world-space points on a surface region (submesh/plane/smooth). Used by the author flow for placement; in audit mode you'd surface "this region has ~12 m² of sampleable area".

Typical audit workflow for the user's "linha laranja é a borda da calçada":
- `read_hierarchy` → identify the sidewalk GameObject.
- `mesh_detect_sharp_edges` → first chain is usually the perimeter.
- `render_region_highlight(chain/0)` → describe what you see.

## Out of scope

Do **not** call any of: `instantiate_prefab`, `create_light`, `create_primitive`, `apply_changeset`, `set_property`, `set_transform`, `select_object` (modifies UI selection — only OK if user asked). If the user asks for fixes, first present the audit, then offer to switch to the author flow.

## Failure modes

- Tool returns 401: token mismatch — instruct the user to copy the token from **Window → Scene Analyzer → Token** and re-paste it in **Admin → MCP Servers**.
- Tool returns "snapshot unavailable" or empty hierarchy: probably no scene open. Ask the user which scene to open.
- `analyze_performance` very slow on first call: snapshot is being built; subsequent calls hit the cache.
