# Spec 005 — Witness Verification (Ed25519 Fix Markers)

**Effort:** S (1 day) · **ROI:** High · **Status:** Proposed
**Inspiration:** [ruflo verification/README.md](https://github.com/ruvnet/ruflo/blob/main/verification/README.md), `plugins/ruflo-core/scripts/witness/{init,regen,verify}.mjs`

---

## Problem

D:\MCP's tests verify code paths, but a class of regressions slips through:
- A "one-line fix" is silently reverted in a refactor 6 months later — no test failed because the bug wasn't covered.
- A subprocess flag parser breaks on Windows but not Linux — CI passes on the Linux runner.
- A `npm install` resolution change breaks the install path — unit tests don't run install.

ruflo hit this exact problem on 2026-05-08 (issues #1859, #1862, #1867 — all passed unit tests on the broken commits but broke for users on first install). They built a **witness layer**: every documented fix gets a SHA-256 + marker substring + Ed25519 signature attesting that "the load-bearing line of this fix is still present in the file." If anyone deletes the line, the witness manifest fails verification and CI blocks publish.

This is **strictly additive** to existing tests, has one dependency (`@noble/ed25519`), and the entire toolkit is ~6 small `.mjs` files.

---

## Solution

Adopt ruflo's witness toolkit, adapted to D:\MCP. Each documented bug fix has an entry in `verification/witness-fixes.json`:

```json
{
  "id": "ISSUE-123",
  "desc": "Sidebar skills injection: must call selectedSkillIds.dedupe() before persisting",
  "file": "packages/code-agent/src/sessions/store.ts",
  "marker": "selectedSkillIds.dedupe()"
}
```

CI per OS (Linux/macOS/Windows) computes `sha256(file)` + checks `file.includes(marker)`, signs the bundle with an Ed25519 key derived from `${ORG_SECRET}:${git_commit}`. Anyone with the same commit can re-derive the public key and verify.

The verifier produces 4 statuses:
- `pass` — sha256 matches + marker present (best case)
- `drift` — marker present, sha256 changed (file modified but fix preserved → log, don't fail)
- `regressed` — marker absent (fix removed → fail CI)
- `missing` — file deleted (fail CI)

---

## Files to create

**Copy from ruflo (slight adaptation):**
- `scripts/witness/init.mjs` — bootstrap `verification/` folders
- `scripts/witness/lib.mjs` — common helpers (fileSha256, fileContains, sign, verify)
- `scripts/witness/regen.mjs` — regenerate per-OS manifest after editing `witness-fixes.json`
- `scripts/witness/verify.mjs` — CI entry point
- `scripts/witness/history.mjs` — append to `<os>/history.jsonl`
- `scripts/witness/perf.mjs` — optional perf-marker variant

**Repo-level:**
- `verification/README.md` — adapted from ruflo's
- `verification/witness-fixes.json` — empty seed (template with `_comment`)
- `verification/{linux,macos,windows}/` — per-OS folders (empty seeds for `manifest.md.json` + `history.jsonl`)
- `verification/mcp-tool-baseline.json` — analog of ruflo's monotone-decreasing tool baseline (optional)

**CI:**
- `.github/workflows/witness-verify.yml` — runs verify.mjs per OS, blocks publish on regression

**Dependencies:**
- Add `@noble/ed25519` to root `package.json` (or to a dedicated `packages/witness/package.json`)

---

## How the witness derives its key

From ruflo's `lib.mjs` (paraphrased — confirm during port):

```javascript
const seed = sha256(`${process.env.WITNESS_SECRET}:${gitCommit}`);
const privateKey = ed25519.utils.randomPrivateKey(seed);  // deterministic
const publicKey = await ed25519.getPublicKey(privateKey);
```

The same commit + secret reproduces the same key. The public key is embedded in the manifest; the verifier re-derives it and checks against the embedded one. Anyone with the secret can sign; anyone with the commit can verify.

**Note**: `WITNESS_SECRET` is a CI-only secret. Local devs run `verify.mjs` against the published manifest without needing the secret (verify only needs the public key, which is in the manifest).

---

## CI workflow shape

`.github/workflows/witness-verify.yml`:

```yaml
name: witness-verify
on: [pull_request, push]
jobs:
  verify:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Verify witness manifest
        run: node scripts/witness/verify.mjs --manifest verification/${{ runner.os == 'Windows' && 'windows' || runner.os == 'macOS' && 'macos' || 'linux' }}/manifest.md.json --root . --json
        # exit 0 = pass, 1 = regression (fail), 2 = precondition (skip with notice)
      - name: Regen + push manifest on main
        if: github.ref == 'refs/heads/master' && success()
        run: |
          node scripts/witness/regen.mjs --root . --secret "${{ secrets.WITNESS_SECRET }}"
          git config user.email "ci@example.com"
          git config user.name "CI"
          git add verification/
          git diff --quiet --cached || git commit -m "ci: refresh witness manifest"
          git push
```

---

## Initial fix list (seed)

Pre-populate `witness-fixes.json` with 5-10 already-shipped fixes that should never regress. Pull from recent commits:

```json
{
  "_comment": "Project-specific NEW_FIXES registered on each witness regen. Append { id, desc, file, marker } per shipped fix. Never edit verification/<os>/manifest.md.json directly — re-run scripts/witness/regen.mjs after editing this file.",
  "fixes": [
    {
      "id": "build-v2#001",
      "desc": "Terminal upgrade errors surface to UI + fix infinite 'Iniciando master' loader (commit 872a5cc)",
      "file": "apps/dashboard/features/terminal/<file>",
      "marker": "<load-bearing-string-from-the-fix>"
    },
    {
      "id": "build-v2#002",
      "desc": "Proxy /ws/* through Vite dev server to HTTP API (commit 66fccda)",
      "file": "apps/dashboard/vite.config.ts",
      "marker": "/ws/"
    }
  ]
}
```

(The actual file paths and markers must be filled in based on the real fixes; this is just a template.)

---

## Tasks

| # | Task | Est |
|---|---|---|
| T1 | Copy + adapt the 6 `.mjs` files from ruflo's `plugins/ruflo-core/scripts/witness/` to `scripts/witness/` | 2h |
| T2 | Add `@noble/ed25519` dependency | 10min |
| T3 | Adapt `init.mjs` to D:\MCP's path layout | 1h |
| T4 | Run `init.mjs` to bootstrap `verification/` folder + seed `witness-fixes.json` | 30min |
| T5 | Populate `witness-fixes.json` with 5-10 real existing fixes (audit recent PRs) | 2h |
| T6 | Run `regen.mjs` locally to produce initial per-OS manifests + commit them | 30min |
| T7 | Set `WITNESS_SECRET` in GitHub Actions secrets | 10min |
| T8 | `.github/workflows/witness-verify.yml` | 1h |
| T9 | Verify CI passes on a clean PR | 30min |
| T10 | Author "Adding a new fix witness" doc in `verification/README.md` | 1h |
| T11 | Manual regression test: revert one of the seeded fixes locally → run `verify.mjs` → confirm exit 1 with helpful error | 30min |

**Total:** ~1 day

---

## Test plan

### Smoke
1. `node scripts/witness/init.mjs --root .` creates `verification/` folder structure.
2. `node scripts/witness/regen.mjs --root . --secret test-secret` produces a per-OS manifest with valid signature.
3. `node scripts/witness/verify.mjs --manifest verification/linux/manifest.md.json --root .` exits 0.

### Positive
- Run verify on clean main → exit 0.
- All 5+ fixes report `status: pass`.

### Regression detection
- Locally remove the marker line from one seeded fix's file.
- Run verify → exit 1, manifest reports `status: regressed` for that fix.
- Restore the line → exit 0.

### Drift detection
- Reformat a file (whitespace change) without removing the marker.
- Run verify → exit 0 but manifest reports `status: drift` (sha256 changed, marker present).
- History JSONL appended.

### Signature
- Tamper with the manifest (change a `marker` field, keep signature).
- Run verify → exit 1 with signature mismatch.

### Precondition
- Delete `node_modules/@noble/ed25519`.
- Run verify → exit 2 with `precondition: noble-ed25519-not-installed` (so scheduled CI doesn't file false regression bugs).

### Cross-OS
- Run verify on Linux against Windows's manifest → exit 1 (paths/separators differ); the per-OS folder layout is exactly what handles this.

---

## Why this is worth the day

Three points from ruflo's README:

> A regression that deletes the load-bearing line of a fix flips its `markerVerified` to `false`. The CI's `witness-verify` job blocks publish.

> Why per-OS? File hashes drift across platforms (LF vs CRLF normalization, path separators, prebuilt binary differences). Each OS produces its own truthful snapshot.

> [Exit code 2] — scheduled runners use this to distinguish a "needs install+build" environment from a real verification failure, so we stop filing recurring issues on every cron run.

That last point (issue #1880) is the kind of detail you only encode after the fix-the-fix cycle. Adopting the toolkit gets all of these for free.

---

## Out of scope (defer)

- **Sigstore / SLSA attestation** — heavier supply-chain framework; the witness pattern is intentionally lightweight (one npm dep). Layer Sigstore on top if regulatory compliance later requires it.
- **GPG signing** — Ed25519 via `@noble/ed25519` is simpler + no keyring management.
- **Cross-org witness federation** — sharing witness markers between projects (analog of ruflo's IPFS pattern transfer) — not needed.

---

## Open questions

1. **WITNESS_SECRET rotation**: when rotating, all old manifests become unverifiable. Document the rotation runbook before T7.
2. **Per-OS runner availability**: macOS minutes on GitHub Actions are 10× the cost of Linux. Run macOS only on PR to main, not every push? Mirror what ruflo does (they run all three on every push).
3. **Marker false positives**: a marker like `await import('better-sqlite3')` could accidentally appear in an unrelated file. Mitigation: include the file path explicitly so marker matching is per-file, not repo-wide. ruflo's `verify.mjs` already does this — good as-is.
