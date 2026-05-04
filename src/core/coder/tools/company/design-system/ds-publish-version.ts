/**
 * Tool: `ds_publish_version`. Master calls this at the end of a build
 * round to publish the active draft to the embedded Verdaccio.
 *
 * Workflow (pure-ish, all side effects funnelled through stores +
 * VerdaccioService):
 *   1. Resolve the DS session for the current company session.
 *   2. Resolve the draft version (must exist — components-builder creates
 *      it via `ds_record_component`).
 *   3. Compute `source_hash` over `pkg_dir` (excluding node_modules etc.).
 *   4. Compare to the latest published version's hash. If equal, mark the
 *      draft as 'skipped' and return — no registry churn.
 *   5. Otherwise, compute next semver from `next_bump_hint`, set status
 *      'building', call `verdaccioService.publishTarball()`.
 *   6. On success: set status 'published', persist tarball_path, manifest,
 *      mcp_manifest, docs_md, storybook_path; reset hint to 'patch'.
 *   7. On failure: set status 'failed', persist `error`.
 *
 * Source: the agent runs `npm pack` inside the sandbox and provides the
 * resulting tarball path (relative to the project workdir / host mount).
 * The tool reads files via the host filesystem because `ctx.cwd` points
 * to the sandbox's host workdir mount.
 */
import { createHash } from 'node:crypto';
import { resolve as resolvePath, isAbsolute, join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { CoderTool, JsonSchema, ToolContext } from '../../../core/tool.js';
import { ok, err } from '../../../core/tool.js';
import type { CompanyOrchestrator } from '../../../company/orchestrator.js';
import type { DesignSystemStore } from '../../../../../store/design-system-store.js';
import { getDesignSystemStore, getSkillStore } from './store-binding.js';
import { tryGetVerdaccioService } from '../../../../verdaccio/verdaccio-service.js';
import { bumpSemver, resolveBumpKind } from '../../../../design-system/semver-bump.js';
import { runNpm } from '../../../../design-system/run-npm.js';
import { auditDesignSystemPackage, formatPackageAudit } from '../../../../design-system/package-audit.js';

const NPM_PACK_TIMEOUT_MS = 120_000;

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    pkg_dir: {
      type: 'string',
      description:
        'Path to the package source directory (relative to project root or absolute). The tool runs `npm pack` here automatically when tarball_path is omitted, so this MUST be the directory that contains package.json.',
    },
    tarball_path: {
      type: 'string',
      description:
        'OPTIONAL. Path to a pre-built .tgz. Omit it to let the tool run `npm pack` inside pkg_dir itself — recommended.',
    },
    manifest_json: {
      type: 'string',
      description: 'Optional JSON manifest of components/pages exported by the package.',
    },
    mcp_manifest_json: {
      type: 'string',
      description: 'Optional JSON manifest of the auto-generated MCP server tools.',
    },
    docs_md: {
      type: 'string',
      description: 'Optional markdown documentation aggregate (will be shown in Docs tab).',
    },
    storybook_path: {
      type: 'string',
      description:
        'Optional path to `storybook-static/` (relative to project root). Served as iframe in Docs tab.',
    },
  },
  required: ['pkg_dir'],
};

export function dsPublishVersion(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  return {
    name: 'ds_publish_version',
    description:
      'Finalise the current draft Design System version: hash sources, bump semver, publish tarball to Verdaccio, persist manifests + docs. Skip-publishes when source_hash matches the last published version.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      try {
        const store = getDesignSystemStore();
        if (!store) return err('ds_publish_version: DesignSystemStore not wired.');
        const verdaccio = tryGetVerdaccioService();
        if (!verdaccio) return err('ds_publish_version: VerdaccioService not wired.');

        const session = store.getSessionByCompanySessionId(orchestrator.companySessionId);
        if (!session) {
          return err(
            `No DesignSystemSession bound to company_session_id=${orchestrator.companySessionId}.`,
          );
        }
        let draft = store.getLatestVersionAny(session.id);
        // Accept `'failed'` AND `'skipped'` as retry targets:
        //   - 'failed' means "publish attempt errored, fix the cause
        //     and retry" (not "buried forever").
        //   - 'skipped' means "previous publish saw no source change
        //     since the last published version". The skip detection
        //     uses `computeSourceHash` which excludes `dist/` and
        //     `storybook-static/` — when the agent's changes happen
        //     to land in those build outputs but not in `src/`, the
        //     hash collides with the prior published version and the
        //     row gets marked skipped. The operator legitimately
        //     wants to publish anyway. Re-run the hash check on
        //     retry; if content really hasn't changed we'll re-skip
        //     idempotently. Either way, no deadlock.
        // Without this branch the tool refused both states with a
        // confusing "not a draft" error and the operator had to drop
        // to SQL surgery (session 73 v1.2.2 incident).
        if (draft && (draft.status === 'failed' || draft.status === 'skipped')) {
          draft = store.updateVersion(draft.id, { status: 'draft', error: null });
        }
        // Recovery path: if no draft exists at all (e.g. extractor never
        // got to call ds_record_component because the container died),
        // create one on the spot. Components table will be empty for
        // this version — that's a known gap the operator can patch by
        // re-running record calls — but at least the publish succeeds.
        if (!draft) {
          const isFirst = !store.getLatestPublishedVersion(session.id);
          draft = store.createVersion({
            ds_session_id: session.id,
            semver: 'pending',
            bump_kind: isFirst ? 'initial' : session.next_bump_hint,
            status: 'draft',
          });
        }
        if (draft.status !== 'draft' && draft.status !== 'building') {
          return err(
            `Latest version (id=${draft.id}, status=${draft.status}) is not a draft. ` +
              `Only draft / building / failed / skipped states can be published. ` +
              `If this row should be retried, set its status back to 'draft' first.`,
          );
        }

        // Resolve the package directory in HOST coordinates. The agent
        // sees and operates on container paths (`/app/pkg`); host-side
        // tooling like `npm pack` needs the bind-mount equivalent.
        const pkgResolved = resolveHostPath(mustString(args.pkg_dir, 'pkg_dir'), ctx);
        if (pkgResolved.kind === 'no-bind-mount') {
          return err(pkgResolved.message);
        }
        const pkgDir = pkgResolved.path;

        const audit = await auditDesignSystemPackage(pkgDir);
        if (!audit.ok) {
          const auditMessage = formatPackageAudit(audit);
          store.updateVersion(draft.id, {
            status: 'failed',
            error: shortenError(auditMessage),
          });
          return err(
            [
              'Pre-publish package audit failed. The package was not packed or published.',
              auditMessage,
            ].join('\n'),
          );
        }

        // Tarball resolution. Either the master passed a pre-built path
        // (legacy / explicit override), OR — recommended — we run
        // `npm pack` ourselves in pkg_dir. Master agents lack shell
        // access; doing it here removes the orchestration overhead.
        let tarballPath: string;
        const explicitTarball = optString(args.tarball_path);
        if (explicitTarball) {
          const tarResolved = resolveHostPath(explicitTarball, ctx);
          if (tarResolved.kind === 'no-bind-mount') {
            return err(tarResolved.message);
          }
          tarballPath = tarResolved.path;
          try { await stat(tarballPath); } catch {
            return err(`Tarball not found at ${tarballPath} (passed explicitly via tarball_path).`);
          }
        } else {
          const packRes = await packPackage(pkgDir);
          if (!packRes.ok || !packRes.tarballPath) {
            return err(
              [
                `npm pack failed in ${pkgDir} (exit ${packRes.exitCode}).`,
                `Stderr: ${shortenError(packRes.stderr) || '(empty)'}`,
                `Stdout: ${shortenError(packRes.stdout) || '(empty)'}`,
              ].join('\n'),
            );
          }
          tarballPath = packRes.tarballPath;
        }

        // Step: hash + skip detection.
        //
        // We hash the TARBALL (the actual artefact about to be
        // published) rather than the source directory. Reasons:
        //
        //   1. `npm pack` is what produces the artefact, and it
        //      respects `package.json#files` — including `dist/`,
        //      `storybook-static/` and other build outputs that the
        //      old `computeSourceHash` excluded. CSS-only fixes that
        //      land in `dist/` would otherwise produce a hash collision
        //      and the draft got auto-skipped (session 73 v1.2.2
        //      incident).
        //   2. The tarball already exists at this point — there's no
        //      perf cost to hashing it (we'd have packed regardless of
        //      the skip decision; the source-hash short-circuit was
        //      illusory).
        //   3. Two byte-identical tarballs produce the same hash. One
        //      byte different → different hash → publish. Same model
        //      as npm's own integrity check.
        const sourceHash = await hashTarball(tarballPath);
        const lastPublished = store.getLatestPublishedVersion(session.id);
        if (lastPublished && lastPublished.source_hash === sourceHash) {
          store.updateVersion(draft.id, {
            status: 'skipped',
            source_hash: sourceHash,
          });
          return ok(
            `Tarball is byte-identical to v${lastPublished.semver} — draft marked 'skipped' (tarball_hash=${shortHash(sourceHash)}). No registry churn.`,
          );
        }

        // Step: compute next semver + bump_kind.
        const previousSemver = lastPublished?.semver ?? null;
        const bumpKind = resolveBumpKind({ previous: previousSemver, hint: session.next_bump_hint });
        const nextSemver = bumpSemver(previousSemver, bumpKind);

        // Step: mark building.
        store.updateVersion(draft.id, {
          status: 'building',
          source_hash: sourceHash,
        });

        // Step: publish to verdaccio.
        const publishResult = await verdaccio.publishTarball({
          tarballPath,
          packageName: session.package_name,
          semver: nextSemver,
        });

        if (!publishResult.ok) {
          store.updateVersion(draft.id, {
            status: 'failed',
            error: shortenError(publishResult.stderr || publishResult.stdout),
          });
          return err(
            `Verdaccio publish failed (exit=${publishResult.exitCode}). Stderr (truncated): ${shortenError(publishResult.stderr)}`,
          );
        }

        // Auto-populate artifacts from the package filesystem when not
        // explicitly passed. Master used to have to read each file with
        // `read_file` and pass them as args, which (a) inflated its
        // prompt with megabytes of docs and (b) silently failed when
        // the master forgot — leaving the dashboard's Docs/Storybook
        // tabs blank for a successful publish. Prefer explicit args
        // (caller knows best) but fall back to disk discovery before
        // landing on the stale draft value.
        const discovered = await discoverArtifacts(pkgDir, ctx.cwd);

        // Step: persist artefacts + mark published. Rewrites semver into the row.
        const now = new Date().toISOString();
        const persisted = store.updateVersion(draft.id, {
          status: 'published',
          tarball_path: tarballPath,
          manifest_json: optString(args.manifest_json) ?? discovered.manifest_json ?? draft.manifest_json,
          mcp_manifest_json: optString(args.mcp_manifest_json) ?? discovered.mcp_manifest_json ?? draft.mcp_manifest_json,
          docs_md: optString(args.docs_md) ?? discovered.docs_md ?? draft.docs_md,
          storybook_path: optString(args.storybook_path) ?? discovered.storybook_path ?? draft.storybook_path,
          markPublished: true,
        });
        // Rewrite semver + bump_kind to reflect the resolved values (the
        // draft was created with semver='pending'). We do it via a raw
        // statement because store.updateVersion deliberately doesn't
        // expose semver — semver shouldn't change once published.
        rewriteSemver(store, draft.id, nextSemver, bumpKind, /* isAutoBump */ false);

        // Reset hint so the next round defaults to patch.
        if (session.next_bump_hint !== 'patch') {
          store.setNextBumpHint(session.id, 'patch');
        }

        // Auto-upsert a global inline skill so that regular chat agents
        // discover this design system on their next session start.
        upsertDesignSystemSkill(store, persisted.id, session.package_name, nextSemver, publishResult.registryUrl);

        void agentRole; void agentRunId;
        return ok(
          [
            `Published ${session.package_name}@${nextSemver} (bump=${bumpKind}, version_id=${persisted.id}, hash=${shortHash(sourceHash)}).`,
            `Registry: ${publishResult.registryUrl}`,
            `Tarball: ${tarballPath}`,
            `Published at: ${now}`,
          ].join('\n'),
        );
      } catch (e) {
        return err(`ds_publish_version failed: ${(e as Error).message}`);
      }
    },
  };
}

/**
 * Rewrite semver + bump_kind on the version row directly.
 *
 * Why a private path: `DesignSystemStore.updateVersion` deliberately
 * omits `semver` and `bump_kind` from its allowed patch keys — published
 * versions are immutable from the typical update path. We poke the
 * underlying handle here, scoped to a single tool call right after a
 * successful publish, to materialise the resolved values that the
 * draft row didn't know yet.
 */
function rewriteSemver(
  store: DesignSystemStore,
  versionId: number,
  semver: string,
  bumpKind: 'initial' | 'patch' | 'minor' | 'major',
  isAutoBump: boolean,
): void {
  const handle = (store as unknown as { db: import('better-sqlite3').Database }).db;
  handle
    .prepare(
      'UPDATE design_system_versions SET semver = ?, bump_kind = ?, is_auto_bump = ? WHERE id = ?',
    )
    .run(semver, bumpKind, isAutoBump ? 1 : 0, versionId);
}

function resolveAgainstCwd(cwd: string, p: string): string {
  return isAbsolute(p) ? resolvePath(p) : join(cwd, p);
}

export type HostPathResult =
  | { kind: 'ok'; path: string }
  | { kind: 'no-bind-mount'; message: string };

/**
 * Resolve a path argument from the agent into a host-filesystem path.
 *
 * The DS publish tool runs in the HOST Node.js process — its `npm pack`,
 * `readFile`, and `computeSourceHash` calls all hit the host filesystem.
 * But for builder-mode sessions, `ToolContext.cwd` is the CONTAINER
 * workdir (`/app`) per `coder/index.ts:445`, so naive
 * `join(ctx.cwd, 'pkg')` produces `/app/pkg` — which becomes `\app\pkg`
 * on Windows and ENOENTs because the host filesystem doesn't have it.
 *
 * Resolution strategy when a sandbox binding with `hostWorkdirMount`
 * is available:
 *
 * - **relative path** (`'pkg'`)            → `<hostMount>/pkg`
 * - **absolute container path** (`/app/pkg`) → `<hostMount>/pkg` (strip prefix)
 * - **absolute host path** (`D:\elsewhere`) → unchanged (already correct)
 *
 * Without a bind-mount: a sandbox with ephemeral fs cannot be reached
 * from the host process. Returning a typed error lets the caller emit
 * a useful message instead of an opaque ENOENT.
 *
 * Without any sandbox at all (legacy non-builder session): falls back
 * to `resolveAgainstCwd` so this helper is safe to use everywhere.
 *
 * Pure: no I/O. Exported for unit-testability (cross-platform path
 * separator behaviour matters and is locked by tests).
 */
export function resolveHostPath(p: string, ctx: ToolContext): HostPathResult {
  const sb = ctx.companyContext?.sandbox;

  // Legacy non-builder session: no sandbox at all. Tools resolved
  // against `ctx.cwd` (which IS the host project root in this mode).
  if (!sb) {
    return { kind: 'ok', path: resolveAgainstCwd(ctx.cwd, p) };
  }

  // Builder session, but provisioned without a host bind-mount —
  // the package lives in container-ephemeral fs and the host process
  // genuinely cannot reach it. Surface a clear message.
  if (!sb.hostWorkdirMount) {
    return {
      kind: 'no-bind-mount',
      message:
        `ds_publish_version requires a sandbox with a host bind-mount, but ` +
        `this session's sandbox was provisioned without \`hostWorkdirMount\`. ` +
        `The package is inside the container ephemeral filesystem and not ` +
        `accessible from the host. Re-create the session with ` +
        `builder.stack='node-only' (which always sets a bind-mount), or copy ` +
        `the tarball out of the container manually and pass an absolute host ` +
        `path via \`tarball_path\`.`,
    };
  }

  const hostMount = sb.hostWorkdirMount;
  const containerWorkdir = sb.workdir;

  // Relative paths: join with host mount.
  if (!isAbsolute(p)) {
    return { kind: 'ok', path: join(hostMount, p) };
  }

  // Absolute paths — could be a container path (translate) or a host
  // path (pass through). Match by container workdir prefix using
  // forward-slash normalisation so trailing-slash and Windows-style
  // input both work.
  const normalizedP = p.replace(/\\/g, '/');
  const normalizedContainer = containerWorkdir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    normalizedP === normalizedContainer ||
    normalizedP.startsWith(normalizedContainer + '/')
  ) {
    const rel = normalizedP.slice(normalizedContainer.length).replace(/^\/+/, '');
    return { kind: 'ok', path: rel ? join(hostMount, rel) : hostMount };
  }

  // Some other absolute path (typically already a host path the
  // caller resolved themselves). Pass through `resolvePath` for
  // canonicalisation.
  return { kind: 'ok', path: resolvePath(p) };
}

function shortHash(h: string): string {
  return h.slice(0, 12);
}

/**
 * SHA-256 of a tarball file. Used as the canonical source-of-truth for
 * "did the published artefact change?" comparisons. The whole file is
 * loaded into memory; tarballs are typically a few MB and this runs
 * once per publish, so streaming would be a premature optimisation.
 */
export async function hashTarball(tarballPath: string): Promise<string> {
  const buf = await readFile(tarballPath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Truncate keeping the TAIL of the message (where the actual error
 * code lives) plus a small head sample so the user still sees the
 * command context.
 *
 * Why tail-biased: `npm publish` (and `npm pack`) emit a long block of
 * `npm notice` lines describing the tarball BEFORE the actual error
 * line at the bottom (`npm error code ENEEDAUTH`, `E401`, etc). A
 * head-biased truncation hides exactly the part that explains the
 * failure — bug observed in session 73 where the operator saw
 * `npm notice 5.2kB README.md ...` and never the auth-required line.
 */
export function shortenError(s: string, max = 1200): string {
  if (s.length <= max) return s;
  // Allocate ~20% to head (context) and ~80% to tail (the diagnostic
  // payload). Float boundaries on whole-line breaks where possible.
  const headBudget = Math.floor(max * 0.2);
  const tailBudget = max - headBudget;
  const head = s.slice(0, headBudget);
  const tail = s.slice(s.length - tailBudget);
  const dropped = s.length - headBudget - tailBudget;
  return `${head}\n…(${dropped} bytes truncated; tail follows)…\n${tail}`;
}

function mustString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return v;
}

function optString(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  return v;
}

/**
 * Run `npm pack` inside `pkgDir` and resolve the produced `.tgz`.
 *
 * `npm pack` (without flags) writes the tarball to the current working
 * directory and prints the filename on the last line of stdout. We
 * parse that line and join with `pkgDir` to get an absolute host path.
 *
 * Exported for unit-testability — `packPackage` mocks well via the
 * shared `runNpm` helper.
 */
export async function packPackage(pkgDir: string): Promise<{
  ok: boolean;
  exitCode: number;
  tarballPath?: string;
  stdout: string;
  stderr: string;
}> {
  const res = await runNpm({
    args: ['pack', '--silent'],
    cwd: pkgDir,
    timeoutMs: NPM_PACK_TIMEOUT_MS,
  });
  if (!res.ok) return { ...res };
  const tarballName = extractPackedTarballName(res.stdout);
  if (!tarballName) {
    return { ...res, ok: false };
  }
  return { ...res, tarballPath: resolvePath(join(pkgDir, tarballName)) };
}

/**
 * Best-effort discovery of the four optional artifact fields from the
 * package filesystem. All four are tried; whatever doesn't exist is
 * left as `null` so the caller's chain of fallbacks (explicit arg →
 * disk discovery → previous draft value) keeps working.
 *
 * - `docs_md`        → `pkg/docs.md` (the aggregated single-file docs).
 * - `storybook_path` → `pkg/storybook-static/` directory IF it has an
 *                       `index.html`. Stored as an absolute host path
 *                       so the proxy route (`/storybook/*`) can serve
 *                       files without further resolution.
 * - `manifest_json`  → `pkg/manifest.json` (component manifest).
 * - `mcp_manifest_json` → `pkg/mcp/manifest.json` (auto-MCP manifest).
 */
export async function discoverArtifacts(pkgDir: string, ctxCwd: string): Promise<{
  docs_md: string | null;
  storybook_path: string | null;
  manifest_json: string | null;
  mcp_manifest_json: string | null;
}> {
  const result = {
    docs_md: null as string | null,
    storybook_path: null as string | null,
    manifest_json: null as string | null,
    mcp_manifest_json: null as string | null,
  };
  void ctxCwd;

  // docs.md (text)
  try {
    const p = join(pkgDir, 'docs.md');
    const buf = await readFile(p, 'utf8');
    if (buf.length > 0) result.docs_md = buf;
  } catch { /* missing — keep null */ }

  // storybook-static/index.html — registers the directory
  try {
    const sbDir = join(pkgDir, 'storybook-static');
    const indexHtml = join(sbDir, 'index.html');
    await stat(indexHtml);
    result.storybook_path = sbDir;
  } catch { /* missing — keep null */ }

  // manifest.json (parse-validate before storing so a malformed file
  // doesn't poison the row — the dashboard expects valid JSON).
  try {
    const buf = await readFile(join(pkgDir, 'manifest.json'), 'utf8');
    JSON.parse(buf);
    result.manifest_json = buf;
  } catch { /* missing or invalid — keep null */ }

  // mcp/manifest.json (same validation rule)
  try {
    const buf = await readFile(join(pkgDir, 'mcp', 'manifest.json'), 'utf8');
    JSON.parse(buf);
    result.mcp_manifest_json = buf;
  } catch { /* missing or invalid — keep null */ }

  return result;
}

/**
 * After a successful publish, upsert a global inline skill so that any
 * regular chat agent session automatically gets design system context
 * (package name, install command, component list) injected into its
 * system prompt.
 *
 * Silently swallows errors — skill creation is best-effort and must
 * never block the publish success path.
 */
function upsertDesignSystemSkill(
  dsStore: DesignSystemStore,
  versionId: number,
  packageName: string,
  semver: string,
  registryUrl: string,
): void {
  try {
    const skillStore = getSkillStore();
    if (!skillStore) return;

    const slug = packageName
      .replace(/^@[^/]+\//, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const skillId = `ds-ctx-${slug}`;

    const components = dsStore.listComponents(versionId);
    const componentLines = components
      .map((c) => `- \`${c.name}\` (${c.kind})`)
      .join('\n');

    const promptBody = [
      `## Design System disponível: \`${packageName}@${semver}\``,
      ``,
      `Instale com:`,
      `\`\`\``,
      `npm install ${packageName} --registry ${registryUrl}`,
      `\`\`\``,
      ``,
      `### Componentes disponíveis`,
      componentLines || '(nenhum componente registrado nesta versão)',
    ].join('\n');

    skillStore.upsertSkill({
      id: skillId,
      name: `Design System: ${packageName}`,
      description: `Contexto do pacote ${packageName}@${semver} publicado localmente. Use para gerar código com os componentes disponíveis.`,
      prompt_body: promptBody,
      scope: 'global',
      enabled: true,
      context_mode: 'auto',
      source: 'builtin',
      tags: ['design-system'],
    });
  } catch {
    // best-effort — do not surface skill errors on the publish result
  }
}

/**
 * Pure: pull the `.tgz` filename out of `npm pack` stdout.
 *
 * `npm pack --silent` prints exactly one line: the tarball filename.
 * Without `--silent` it prints a notice block + filename last. We
 * defensively scan all lines for the first one ending in `.tgz` to
 * survive both shapes plus eventual line-buffering quirks.
 */
export function extractPackedTarballName(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].endsWith('.tgz')) return lines[i];
  }
  return null;
}
