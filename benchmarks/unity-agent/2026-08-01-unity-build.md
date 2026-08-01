# Unity Build agent and smart tool-window benchmark — 2026-08-01

## Scope

- Managed native agent: `custom:unity-build`, owned by Unity package `com.maicon.scene-analyzer` `0.16.24`.
- Live Editor: Unity `6000.3.5f2`, project `F:\Warzombie\WaveZombie\ZombieWave`.
- Provider/model: `openai-chatgpt` / `gpt-5.6-sol`.
- Managed catalog policy: 16 required Unity pins, tier `unity`, visible cap 64.
- Runtime catalog during the focused test: 407 eligible tools.

## Tool-window defect and correction

The prior runtime had discovery and cap logic, but dynamic pins were append-only. Every hidden tool ever called became protected forever. On a strict provider, `find_tools` also had a catch-22: it described a hidden tool but did not send that tool's schema on the following request, so the model frequently selected a visible substitute.

The corrected policy is:

1. Required agent pins and native safety/lifecycle tools form the permanent floor.
2. Runtime-discovered tools use a bounded LRU window (default 16; configurable with `CODER_DYNAMIC_TOOL_PIN_LIMIT`, clamped to 1–64).
3. A strong top hidden result from `find_tools` is activated automatically for the next provider turn. Weak/ambiguous results do not change membership.
4. Adding a dynamic tool keeps the total at the configured cap by replacing the least-recently-used dynamic pin first, then an ordinary low-priority tool when the dynamic window is not full.
5. `find_tools` reads the exact last provider catalog, not historical pin membership.
6. Exact bounded membership and cap updates are persisted immediately and again at run finalization. Removed pins are removed from `state.json` instead of returning after restart.

## Focused live evidence

### Before automatic activation

Session `cd4ade3e-cced-4afa-871c-1e8ec1f39036` found `ext_unity__look_at`, but the next model turn used visible `ext_unity__apply_changeset` instead of the requested direct hidden tool. This demonstrated that discovery text alone was not sufficient.

### After automatic activation

Session `f8ef8922-5e56-4792-b2d5-a3e8e675289e` executed this exact useful path:

`ext_unity__get_server_health` → `find_tools("ext_unity__look_at")` → direct `ext_unity__look_at` → final text.

Provider catalog evidence:

- Before discovery: `407 → 64`: 44 hard-protected + 0 dynamic + 20 ordinary.
- After discovery: `407 → 64`: 44 hard-protected + 1 dynamic + 19 ordinary.
- Direct result: `looking at (0.00, 1.50, 4.00)` for camera instance `-274824` and target `-274098`.
- Session usage: 50,860 input tokens, 162 output tokens.

The catalog remained at 64: `ext_unity__look_at` entered and an ordinary tool (`git_log` at this boundary) left.

### Persistence confirmation

Session `f14eef57-536f-4d17-8d8b-89a2621e43ce` repeated the direct activation successfully. Its filesystem `state.json` persisted:

```json
{"extraTiers":[],"pins":["ext_unity__look_at","find_tools","ext_unity__read_component"],"v":1,"visibleCap":64}
```

The session's global verification policy added a scene query and component read after the requested direct call. That extra behavior raised usage to 107,451 input / 1,009 output tokens; it is agent-loop overhead, not a failure of tool replacement. At every catalog rebuild, the count remained 64 (44 hard + 1/2 dynamic + 19/18 ordinary).

## Unity level outcome

The native managed agent created and saved:

`F:\Warzombie\WaveZombie\ZombieWave\Assets\Game\Scenes\Benchmark_UnityBuild_Arena.unity`

Current artifact size: 121,122 bytes. The final Unity run confirmed package health `0.16.24`, a saved scene with explicit roots, and visual render evidence. Earlier construction runs exposed two independent inefficiencies: a `ToolTargetRef` schema disconnect and repeated `look_at` validation. The schema issue was corrected; the smart window now makes specialized direct tools reachable without inflating the base catalog. Verification-loop tuning remains separate from tool-cap correctness.

## Automated validation

- Focused Vitest: 6 files, 65 tests passed.
- TypeScript: `pnpm exec tsc --noEmit --pretty false` passed.
- Full build: `pnpm run build:all` passed; dashboard transformed 6,171 modules.
- `git diff --check` passed (workspace-wide line-ending warnings only).

## Interpretation of “59”

59 was not a provider maximum. It was the old protected subtotal (31 Unity pins plus 28 native/protected tools), which left almost no replaceable surface under the chosen cap. The managed agent now has 16 Unity pins and a cap of 64. In the live run, the actual permanent floor was 44 and the remaining 20 slots were available to the bounded dynamic/ordinary working set.
