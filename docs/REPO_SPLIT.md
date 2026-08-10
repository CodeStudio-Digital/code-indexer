# Repository Split — Final Validation Report

> Validation completed on 2026-08-09. Paths removed from the Desktop repository
> were preserved outside the active repos under `D:\repos\_archive\split-2026-08-09`;
> no local file or configuration was deleted.

## Final topology

| Repository | Local path | Ownership |
| --- | --- | --- |
| `codestudio-desktop` | `D:\MCP` | Electron IDE, dashboard, local services, agents, indexer, plugins and native runtime |
| `codestudio-cloud` | `D:\repos\codestudio-cloud` | Cloud API, account portal, Cloud bounded contexts and plugin-market Worker |
| `codestudio-unity` | `D:\repos\codestudio-unity` | `com.maicon.scene-analyzer` Unity package, Broker and Sidecar |

## Safety and history

- `backup/pre-split-2025` preserves the Desktop pre-split commit.
- Cloud was extracted with `git filter-repo`, retaining the histories of all Cloud paths.
- Unity was cloned from the embedded Git repository with `git clone --no-local`, retaining the then-current 113 commits.
- `git fsck`/connectivity checks pass in all three repositories.
- At split validation time, the 45 modified/untracked Unity files had identical path sets and SHA-256 hashes in the embedded source and standalone clone. During final Desktop/Cloud cleanup, the embedded repository independently advanced by one descendant commit (`e818b60`, release `0.18.2`) while the standalone repository remained at `3d76695` (`0.18.1`). Per explicit user instruction, Unity was not synchronized or otherwise modified.
- `private_key_pkcs8.pem` is ignored, is not tracked, and was not found in Git history. No history rewrite was required.
- Desktop/Cloud residual trees, the former Cloud workflow copy, scratch data, temporary extraction tools and competing lockfiles are preserved in `D:\repos\_archive\split-2026-08-09`; its manifest covers 24 entries, 9,929 files and 582,845,842 bytes with deterministic tree SHA-256 hashes.
- Cloud local-only configuration is centralized under `D:\repos\_local-config\codestudio-cloud`; the Market PKCS#8 key, production secrets file and imported root `.env` are outside Git, and the active Cloud `.dev.vars` retains a hash-identical backup there.
- The embedded Unity source, its backups, validation harnesses, reports and validation environment remain in their original locations by explicit user request; no Unity path or remote was changed during final cleanup.
- Desktop retains its GitHub `origin`; Cloud is published privately at `https://github.com/CodeStudio-Digital/codestudio-cloud` with `feature/ide-mvp` as its default branch; Unity's `origin` remains the local embedded source repository.

## Secret audit

Gitleaks 8.30.1 scanned every reachable commit with redaction enabled:

- Desktop: 298 commits scanned, 34 findings;
- Cloud: 34 commits scanned, 6 findings;
- Unity: 113 commits scanned, 0 findings.

Every Desktop/Cloud finding was classified by rule, historical file, line and commit without printing the detected value. They are existing test fixtures for secret redaction/safety, documentation password examples, public OAuth client identifiers, UI identifiers or non-secret workspace identifiers. No operational credential was identified. The six Cloud findings are confined to `docs/cloud-api/openapi.yaml` examples and `packages/cloud-sharing/src/__tests__/redaction.test.ts` fixtures.

The raw Gitleaks command remains non-zero for Desktop and Cloud because no broad allowlist was added: silently excluding whole fixture/docs paths could hide a future real leak. This is a pre-existing CI hygiene blocker, not a split regression. Scanning only the final diffs produced zero findings for Cloud and Unity; the eight Desktop diff findings are duplicated fixture/example values carried in removal hunks for the extracted Cloud tree. `private_key_pkcs8.pem` was also checked directly across tracked paths and all refs in each repository and had zero matches.

## Boundaries

Desktop owns none of the extracted Cloud or Unity implementation trees in its Git index after the split; consumer-side Cloud contracts and references remain where the Desktop still needs them. The ignored embedded Unity working copy is temporarily preserved in place by user request. Desktop's workspace, TypeScript aliases, Vitest aliases and Knip configuration exclude the extracted Cloud packages. The enforced boundary manifest and ratchet live in:

- `scripts/repository-boundaries.json`
- `scripts/repository-boundaries-baseline.json`
- `scripts/check-repository-boundaries.ts`
- `src/__tests__/repository-boundaries.test.ts`

The final ratchet records 4,076 known pre-existing architecture issues, down from the initial 4,110-entry snapshot, and rejects any new issue. The checker and its four focused tests pass against the final Desktop index.

Cloud has no `@mcp/*`, `@codestudio/*`, Desktop source-path or Unity dependency. The Portal's former type-only dependency on `@mcp/api-bus` is now producer-owned by `@cloudstudio/cloud-contract`.

Unity is a standalone UPM package and does not depend on either TypeScript repository.

## Reproducible validation

### Desktop

```cmd
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check:boundaries
pnpm exec vitest run src/__tests__/repository-boundaries.test.ts
pnpm typecheck
pnpm run build:all
pnpm exec vitest run --reporter=json --outputFile=temp-split-desktop-tests.json
```

Observed:

- frozen install: passed;
- boundary checker and boundary test: passed;
- typecheck: passed;
- full TypeScript + dashboard production build: passed;
- broad Vitest run: 11,833 tests, 11,633 passed and 151 failed across 57 files.

The broad Desktop suite is not globally green for reasons that predate and do not cross the split boundary. The remaining failures include unavailable `isolated-vm` (8 script-runtime cases), locale expectations, database fixture/schema expectations and unrelated agent/runtime assertions. `better-sqlite3` and `node-pty` load after rebuilding for the current Node ABI. No failed file belongs to an extracted workspace, and the focused boundary gate is green.

### Cloud

```cmd
pnpm install --frozen-lockfile --ignore-scripts
pnpm validate
```

`pnpm validate` runs all three TypeScript targets, 190 Cloud tests, the Portal production bundle, Wrangler type validation and dry-run packaging for both Workers. Observed results:

- frozen install across 10 workspaces: passed;
- Cloud API, Portal and Market Worker typechecks: passed;
- Vitest: 19 files and 190 tests passed;
- Portal Vite production build: passed;
- Cloud API Wrangler types: up to date;
- Cloud API and Market Worker `wrangler deploy --dry-run`: passed without deployment.

Split-caused gaps corrected during validation:

- synthesized files normalized from UTF-8 BOM to portable UTF-8;
- root build/test tools declared explicitly;
- Portal dependencies formerly inherited from the monorepo declared explicitly;
- one reproducible `pnpm-lock.yaml` retained in each TypeScript repo; competing npm/yarn lockfiles were removed from the active indexes, ignored and preserved in the external archive where applicable.

### Unity

```cmd
py -3 Tools~\validate_release.py
py -3 Tools~\validate_modeling_phase0.py
python -m pytest Broker~\tests -q
python -m pytest Sidecar~\tests -q
```

A dedicated disposable Unity 6000.3.5f2 project referenced only `file:D:/repos/codestudio-unity`, with `com.unity.test-framework` 1.6.0 and the package's documented optional `com.unity.ugui` 2.0.0 matrix. Observed results:

- release and modeling static validators: passed;
- Broker: 37 passed;
- Sidecar: 5 passed;
- Unity import/compilation: exit 0, no compiler or UPM errors;
- EditMode: 269 discovered, 266 passed, 3 ignored, 0 failed.

A first fresh-project run without optional uGUI produced one expected `TypeLoadException` in the test that explicitly loads `SetRectTransformTool`; adding the documented uGUI dependency made the complete suite green without changing package code.

## Non-destructive rollback

Do not use `git reset --hard` while local work exists. To inspect or restore tracked pre-split content safely, create a separate worktree or clone from the backup reference:

```cmd
git worktree add D:\repos\codestudio-desktop-pre-split backup/pre-split-2025
```

This leaves the current index, working tree, untracked files and local configuration untouched. Standalone Cloud and Unity repositories can remain alongside that worktree. Desktop/Cloud local residues can be restored individually by following the source/destination mapping in `D:\repos\_archive\split-2026-08-09\manifest.json`; sensitive Cloud configuration is mapped separately in `D:\repos\_local-config\codestudio-cloud\manifest.json`.

## Intentionally not performed

- no deployment, migration or remote resource mutation;
- no physical deletion of source, configuration, caches, lockfiles or harnesses; Desktop/Cloud residues were moved to the hash-manifested external archive;
- no commit, push, force-push, reset or history rewrite;
- no attempt to repair unrelated pre-existing Desktop test failures;
- no synchronization of the one-commit Unity divergence observed after validation; this remains intentionally deferred.
