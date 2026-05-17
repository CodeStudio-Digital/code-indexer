/**
 * Routes — Design System Creator round lifecycle (start / abort / attach).
 *
 *   POST /api/design-system/sessions/:id/start-round   → fresh master run (autonomous)
 *   POST /api/design-system/sessions/:id/abort         → kill the active master + subordinates
 *   GET  /api/design-system/sessions/:id/stream        → SSE attach to live events
 *
 * The DS pipeline runs as a sequence of "rounds". Each Start-round
 * disposes of the previous master conversation (kills the orchestrator,
 * creates a fresh agent_run) so the agent never accumulates a giant
 * chat history. The MASTER PROMPT EMBEDDED IN `user_message` enforces
 * AUTONOMOUS operation: no ask_user, no submit_plan_to_user, no human
 * approval loops. The master orchestrates subordinates, runs the
 * pipeline, calls `ds_publish_version`, and exits.
 *
 * This is intentionally separate from the company `/start` route — DS
 * sessions need a curated user_message, not a free-form one, and the
 * "round" semantic ("each click = fresh chat") differs from the
 * company session model (long-lived, human-in-loop).
 */
import type { Hono } from 'hono';
import { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { orchestratorRegistry } from '../../../sse/OrchestratorRegistry.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';
import type {
  DesignSystemSession,
  DesignSystemVersion,
} from '@mcp/store/design-system-store.js';

interface StartRoundBody {
  /** Optional extra instructions appended to the canonical pipeline prompt. */
  extra_instructions?: string;
  /** Cap turns (defaults to 200 — autonomous DS runs are usually long). */
  max_turns?: number;
}

export function mountDesignSystemRoundRoutes(app: Hono, deps: ServerDeps): void {
  const { designSystemStore, companyStore, db } = deps;

  app.post('/api/design-system/sessions/:id/start-round', async (c) => {
    const id = parseIdParam(c);
    const dsSession = designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);
    const companySession = companyStore.getCompanySession(dsSession.company_session_id);
    if (!companySession) return notFound(c, 'Parent company session not found');

    const body = await parseJsonBody<StartRoundBody>(c);
    const extraInstructions = (body.extra_instructions ?? '').trim();
    const maxTurns = body.max_turns ?? 200;

    // 1. Abort any active orchestrator on the parent company session.
    const existing = orchestratorRegistry.get(companySession.id);
    if (existing) {
      try { existing.abortAll(); } catch { /* swallow */ }
      orchestratorRegistry.delete(companySession.id);
    }

    // 2. Parse role configs persisted in config_json.
    let config: {
      master_provider?: string;
      master_model?: string;
      role_assignments?: Array<{
        role: string; provider: string; model: string; tier: string;
        skills?: string[]; projectIds?: number[]; projectHints?: string[];
        systemPromptOverride?: string;
      }>;
    } = {};
    try { config = JSON.parse(companySession.config_json); } catch { /* defaults */ }
    const roleConfigs = config.role_assignments ?? [];

    // 3. Compute the autonomous master message.
    const latestPublished = designSystemStore.getLatestPublishedVersion(dsSession.id);
    const userMessage = buildDesignSystemMasterMessage({
      dsSession,
      latestPublished,
      extraInstructions,
    });

    // 4. Construct fresh orchestrator + start master. Mirrors company stream.ts /start.
    const orchestrator = new CompanyOrchestrator({
      companySessionId: companySession.id,
      companyStore,
      db,
    });
    orchestratorRegistry.set(companySession.id, orchestrator);

    try {
      await orchestrator.startMaster({
        userMessage,
        provider: config.master_provider ?? 'anthropic',
        model: config.master_model ?? 'claude-sonnet-4-6',
        maxTurns,
        roleConfigs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[design-system] Master start failed for session ${id}:`, msg);
      orchestratorRegistry.delete(companySession.id);
      companyStore.updateCompanySessionStatus(companySession.id, 'error');
      return c.json({ error: `Master start failed: ${msg}` }, 500);
    }

    companyStore.setLastUserMessage(companySession.id, userMessage);

    return pumpBusToSSE(c, orchestrator.metaBus, {
      since: -1,
      onDone: () => orchestratorRegistry.scheduleEviction(companySession.id),
    });
  });

  app.post('/api/design-system/sessions/:id/abort', (c) => {
    const id = parseIdParam(c);
    const dsSession = designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);
    const orch = orchestratorRegistry.get(dsSession.company_session_id);
    if (!orch) return c.json({ ok: true, was_running: false });
    orch.abortAll();
    orchestratorRegistry.delete(dsSession.company_session_id);
    companyStore.updateCompanySessionStatus(dsSession.company_session_id, 'paused');
    return c.json({ ok: true, was_running: true });
  });

  app.get('/api/design-system/sessions/:id/stream', (c) => {
    const id = parseIdParam(c);
    const dsSession = designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);
    const orch = orchestratorRegistry.get(dsSession.company_session_id);
    if (!orch) return c.json({ error: 'Round not running. POST /start-round to start.' }, 404);
    return pumpBusToSSE(c, orch.metaBus, { since: parseLastEventId(c) });
  });
}

/**
 * Build the canonical Design System master message — autonomous,
 * pipeline-prescribed, with session config interpolated.
 *
 * Pure: takes the DS session row + the latest published version (if
 * any) and returns the message string. Tested in
 * `__tests__/design-system-master-message.test.ts` so the autonomous
 * directives never silently drift.
 */
export function buildDesignSystemMasterMessage(opts: {
  dsSession: DesignSystemSession;
  latestPublished: DesignSystemVersion | null;
  extraInstructions: string;
}): string {
  const { dsSession, latestPublished, extraInstructions } = opts;

  const stackSkill =
    dsSession.stack === 'react-ts' ? 'ds-components-react' :
    dsSession.stack === 'vue-ts' ? 'ds-components-vue' :
                                    'ds-components-angular';
  const stackLabel =
    dsSession.stack === 'react-ts' ? 'React + TypeScript' :
    dsSession.stack === 'vue-ts' ? 'Vue 3 + TypeScript' :
                                    'Angular (standalone components)';

  const lastVersionLine = latestPublished
    ? `Last published version: ${latestPublished.semver} (source_hash=${latestPublished.source_hash?.slice(0, 12) ?? 'n/a'}). The next bump kind is **${dsSession.next_bump_hint}**.`
    : `No previous version. The first publish will be **1.0.0** (initial), regardless of next_bump_hint.`;

  const sections: string[] = [];

  sections.push(`# Design System Creator — ROUND START

You are the **${dsSession.name}** Design System master, working **AUTONOMOUSLY** to produce a versioned npm package from the uploaded HTML/CSS/SCSS theme.`);

  sections.push(`## ABSOLUTE RULES — autonomous mode

- **DO NOT call \`ask_user\`.** The operator is not present. If you would normally ask for clarification, decide using sensible design system conventions and proceed. Document the decision in a board post for the operator to review later.
- **DO NOT call \`submit_plan\`.** Skip plan approval. Execute the pipeline directly.
- **DO NOT call \`submit_tasks\` for human approval.** If you want to track tasks internally, use \`todo_write\` instead — that's silent.
- **DO NOT pause waiting for human input.** Every wait_for_subordinates returns naturally when subordinates finish.
- **End the round** by either calling \`ds_publish_version\` (success path) or \`ds_set_version_status({ status: 'failed', error: '...' })\` and returning. Do NOT loop forever.`);

  sections.push(`## Your DS toolbox

You have **seven** \`ds_*\` tools in your schema. Verify by name before claiming any is missing:

- \`ds_get_session_info()\` — read session config (stack, package_name, last published, current draft). Call it FIRST every round.
- \`ds_record_component({ name, kind, props_schema_json, example_code })\` — normally delegated to your subordinates (extractor / components-builder / pages-builder) during a clean round. **You CAN call it directly when subordinates aren't running** (recovery rounds, bulk re-registration after a failure). The first call auto-creates the draft \`design_system_versions\` row.
- \`ds_validate_manifest({ manifest_path: 'manifest.json', strict: true })\` — Phase 1 gate. Validates the extractor output against DesignSystemManifestV2 AND cross-checks every \`props_schema.<key>.values\` and \`css_classes\` against the actual CSS in \`source-inventory/styles.json\`. Rejects shallow manifests, dangling classes, and prop values that don't exist in the source CSS (the "Material UI vocab leaked into Bootstrap" failure mode — error code \`vocab.leak\`).
- \`ds_validate_stories({ component_dir: 'pkg/src' })\` — Phase 2 gate. Parses every \`*.stories.{ts,tsx,jsx,js}\` file and rejects any \`argTypes\` / \`args\` key not declared on the component's \`Props\`, any key not declared in \`manifest.props_schema\`, and any \`argTypes.<key>.options\` literal not in \`manifest.props_schema.<key>.values\`. This is the gate that would have caught the v1.2.2 incident; you MUST call it after Phase 2 completes and before Phase 5b runs \`build-storybook\`.
- \`ds_audit_package({ pkg_dir: 'pkg' })\` — pre-publish gate. Checks package files/bin/exports, MCP manifest, Storybook static output, docs and React story prop drift.
- \`ds_set_version_status({ status: 'failed', error })\` — only when irrecoverable. Status is restricted to \`'failed'\` here.
- \`ds_publish_version({ pkg_dir })\` — Phase 6 finaliser. Tool runs \`npm pack\` itself, auto-discovers \`docs.md\` / \`storybook-static/\` / \`manifest.json\` / \`mcp/manifest.json\` from \`pkg_dir\`, and publishes to Verdaccio. **Mandatory before the round ends.** Accepts \`failed\` drafts as retry targets.

If any of these seven seems missing from your schema, that's a server-side bug — log to the board with \`post_to_board\` and call \`ds_set_version_status({ status: 'failed', error: 'tool not registered' })\`.`);

  sections.push(`## FIDELITY + NO EMOJIS — non-negotiable

You are converting a static theme to a versioned npm package. **Faithful empacotation, not redesign.**

- **Fidelity to the source.** If the theme uses Bootstrap, the package uses Bootstrap. If the palette has \`#9c27b0\`, it stays \`#9c27b0\`. If the typography is Inter via Google Fonts, the package imports Inter via Google Fonts. Do NOT substitute "modern" alternatives, do NOT harmonise colors, do NOT translate dependencies.
- **Subordinates must honour \`manifest.json.dependencies\`** (CSS frameworks, icon fonts, JS libs, fonts) emitted by the extractor. Repeat this in every task description: _"Read manifest.json.dependencies and declare each as peerDependency. Use the framework's classes directly — don't reskin in CSS Modules."_
- **NO EMOJIS in the design system.** No emojis in component names, prop names, descriptions, JSDoc, story titles, README, manifest values, board posts. If the source theme contains emojis, preserve them identically; if it doesn't, never add any.
- **No marketing copy.** Descriptions are technical and terse. "A button." is fine. "A beautiful, modern button" is not.
- **Pass these rules forward.** Subordinates do NOT see this prompt — only the task description you write. So your task descriptions must restate "preserve fonts/deps/markup literally" and "no emojis" every time.
- **Manifest is the SINGLE source of truth for prop vocabulary.** Session 73 v1.2.2: components-builder generated stories with \`variant: 'contained'\` (Material UI vocabulary leaked from training data). The Bootstrap CSS only has \`.btn-primary\`/\`.btn-secondary\`/etc., so \`btn-contained\` matched no rule and Storybook rendered the Button as plain text "Primary". When you spawn \`components-builder\` and \`pages-builder\`, repeat in their task descriptions: _"Your \`argTypes.<prop>.options\` and every \`args\` value in EVERY \`.stories.tsx\`/\`.stories.ts\` must use ONLY literal values from \`manifest.json.components[].props_schema.<prop>.values\`. Never use Material UI vocabulary (\`contained\`/\`outlined\`/\`text\`) unless the manifest explicitly declares those values. Verify before \`submit_plan_to_master\` that every \`argTypes.<prop>.options\` is a SUBSET of \`manifest.props_schema.<prop>.values\` — a story with mismatched values renders as unstyled HTML in the dashboard's Storybook tab, and we're not doing that again."_`);

  sections.push(`## Session config

- **Package**: \`${dsSession.package_name}\`
- **Stack**: ${stackLabel}
- **Source theme files**: already extracted at \`./design_system/\` inside your sandbox workdir (this is the bind-mounted virtual project root). The HTML/CSS/SCSS/SVG files of the uploaded theme are real files there — just \`list_directory ./design_system\` and \`read_file\` them. **No \`unzip\` step needed.**
- **Deterministic source inventory**: the server already wrote a compact index at \`./source-inventory.json\` next to \`./design_system/\`. The detailed shards live under \`./source-inventory/\` (\`dependencies.json\`, \`components.json\`, \`pages.json\`, \`styles.json\`, \`warnings.json\`). Extractor MUST read the index first, follow \`recommended_read_order\`, and use shards before opening individual source files.
- **Working area**: write the generated package under \`./pkg/\` (also inside the workdir).
- ${lastVersionLine}`);

  sections.push(`## Pipeline (execute in this exact order)

Open the round by calling \`ds_get_session_info\` to confirm the current draft state. Then run **6 phases**, in order:

### Phase 1 — Extraction (one subordinate)

Spawn role \`extractor\`. Skill \`ds-extractor\` is auto-loaded into its system prompt — DO NOT mention "load skill" in the task. Task description must be concrete and contain:

> "Phase 1 of the Design System pipeline. FIRST read \`./source-inventory.json\` (compact server-generated index), follow its \`recommended_read_order\`, then read \`./source-inventory/dependencies.json\` and \`./source-inventory/components.json\` as your primary evidence. Open \`pages.json\` and \`styles.json\` only when you need confirmation, and read source files under \`./design_system/\` only to fill missing detail from source_refs. Use the shards' dependencies, pages, selectors, assets and component candidates as your starting evidence. Produce a **DesignSystemManifestV2** at \`./manifest.json\` with \`manifest_version: '2'\`, normalized \`dependencies.css_frameworks/icon_fonts/js_libs/fonts\`, tokens, layouts and components. Every component MUST include \`name\`, \`kind\`, original \`html\`, \`css_classes\`, \`source_refs\`, \`props_schema\`, \`dependencies\` and \`confidence\`. For every component call \`ds_record_component\`. Finally write the complete \`manifest.json\` at workdir root and \`submit_plan_to_master\` with counts. **Fidelity**: preserve font-family literal, dependency names/versions exact, color values exact, class names verbatim, markup tags identical. **NO EMOJIS** — never add any to manifest values, component names, or board posts."

Wait for it. Then call \`ds_validate_manifest({ manifest_path: 'manifest.json', strict: true })\`. If validation fails, re-spawn \`extractor\` exactly once with the validation errors and the instruction to repair \`manifest.json\` using \`source-inventory.json\` plus the relevant \`source-inventory/*.json\` shards; validate again. If the second validation fails, call \`ds_set_version_status({ status: 'failed', error: '<manifest validation errors>' })\` and end the round.

### Phase 2 — Components (one subordinate)

Spawn role \`components-builder\`. Skill \`${stackSkill}\`. Task:

> "Phase 2 of the pipeline. Read the **validated DesignSystemManifestV2** at \`./manifest.json\`, the compact \`./source-inventory.json\` index, and only the source-inventory shards needed for evidence (usually \`dependencies.json\` and \`components.json\`). Treat \`manifest.json\` as the contract, not a suggestion. **First**, read \`manifest.json.dependencies\` and add every entry as a \`peerDependency\` in \`pkg/package.json\` at the exact version. Import their CSS in \`pkg/src/index.ts\` (or the stack-equivalent index). Components must use the framework's class names directly — do NOT reskin in CSS Modules. **Fonts**: copy self-hosted fonts from \`./design_system/\` to \`pkg/src/fonts/\` and emit \`@font-face\`; for Google Fonts, \`@import\` the exact URL in \`pkg/src/index.css\`. **Then** generate one component per \`manifest.json.components[]\` entry with \`kind=atom\`, preserving each component's \`html\`, \`css_classes\`, \`source_refs\` and prop schema. Add CSF3 stories for each. Run \`npm install\` and \`npm run build\` to verify. **NO EMOJIS** in any output. No marketing language. \`submit_plan_to_master\` with the build output and any issues."

Wait. Then call \`ds_validate_stories({ component_dir: 'pkg/src' })\`. If validation fails, re-spawn \`components-builder\` exactly once with the **literal list of mismatches** (each entry like \`Button.stories.tsx: argTypes.variant.options 'contained' not in manifest props_schema.variant.values\`) and the directive: _"Fix every story so that argTypes/args/options use ONLY values from manifest.props_schema. Do not invent vocabulary. Re-run \`npm run build\` and \`submit_plan_to_master\` again."_ Re-validate. If the second \`ds_validate_stories\` call still fails, call \`ds_set_version_status({ status: 'failed', error: 'story validation: <errors>' })\` and end the round — Phase 5b cannot recover from a Phase 2 vocab leak, so don't even try.

### Phase 3 — Page templates (one subordinate)

Spawn role \`pages-builder\`. Skill \`${stackSkill}\`. Runs after Phase 2 (page templates compose atoms). Task:

> "Phase 3 of the pipeline. For every \`manifest.json.components[]\` entry with \`kind='page-template'\` and every \`manifest.json.layouts[]\` entry, generate a page template under \`pkg/src/pages/<Name>/\`. Page templates expose **named slots** typed as ReactNode/Slot/ng-content. Compose atoms from Phase 2 — do NOT re-implement them. Preserve original markup structure verbatim. **NO EMOJIS**, no marketing copy. \`submit_plan_to_master\` when done."

Wait.

### Phase 4 — MCP server (one subordinate)

Spawn role \`mcp-builder\`. Skill \`ds-mcp-server\`. Task:

> "Phase 4 of the pipeline. Read \`pkg/manifest.json\` and the components written in Phase 2/3. Generate \`pkg/mcp/server.ts\` and \`pkg/mcp/manifest.json\` exposing one tool per component (\`ds_use_<component>\`) with input schema mirroring the props_schema. Tools return a string snippet only — no runtime. Update \`pkg/package.json\` to add \`bin\`, include \`mcp\` in \`package.json#files\`, and add \`@modelcontextprotocol/sdk\`. Compile so \`pkg/mcp/server.js\` exists for publish. **NO EMOJIS** in tool names/descriptions. \`submit_plan_to_master\`."

Wait.

### Phase 5 — Docs + Storybook (two subordinates in parallel)

Spawn role \`docs-writer\` (skill \`ds-docs\`) AND role \`storybook-builder\` (skill \`ds-storybook\`) in parallel. Tasks:

- Docs writer: _"Phase 5a. Read \`pkg/manifest.json\`. Produce \`pkg/README.md\`, \`pkg/docs/<component>.md\` for each, and \`pkg/docs.md\` (single-file aggregate concatenated with TOC). Tone: technical, terse. **NO EMOJIS**. No marketing adjectives. \`submit_plan_to_master\`."_
- Storybook builder: _"Phase 5b. Initialise Storybook for \`${stackSkill.replace('ds-components-', '')}\` in \`pkg/\`, point its \`stories\` glob at \`../src/**/*.stories.*\`, run \`npm run build-storybook\`. Output goes to \`pkg/storybook-static/\`. Add \`storybook-static\` to \`package.json#files\`. Verify stories do not use props outside component Props or manifest props_schema. **NO EMOJIS** in titles. \`submit_plan_to_master\` with bundle size."_

Wait for both.

### Phase 6 — Publish (master itself)

Call \`ds_audit_package({ pkg_dir: 'pkg' })\` first. If it returns errors, either route one fix-up subordinate for the exact errors and re-run the audit, or call \`ds_set_version_status({ status: 'failed', error: '<audit errors>' })\` if the package cannot be repaired. Once audit passes, call \`ds_publish_version({ pkg_dir: 'pkg' })\` (for Angular pass \`pkg_dir: 'pkg/dist/<name>'\`). The publish tool also runs the audit as a final safety check, then **runs \`npm pack\` itself**, computes source_hash, decides next semver, and either publishes to Verdaccio or marks the version as \`'skipped'\` when nothing changed. You don't need to run any shell — that's why this tool exists.

Optional: pass \`docs_md\` (string of \`pkg/docs.md\` contents) and \`storybook_path\` (e.g. \`pkg/storybook-static\`) so the dashboard tabs render. Read these files with \`read_file\` before calling.`);

  sections.push(`## YOU MUST PUBLISH OR FAIL EXPLICITLY

Before this round can end, you are OBLIGATED to call EXACTLY ONE of:

- \`ds_publish_version({ pkg_dir: 'pkg' })\` — success path. The tool itself runs \`npm pack\`, hashes sources, picks the next semver, and publishes to Verdaccio. If nothing changed since the last publish, it marks the version as \`'skipped'\` (which is a perfectly valid round outcome).
- \`ds_set_version_status({ status: 'failed', error: '<short reason>' })\` — when a subordinate failed twice (retry policy auto-retries once already) or any unrecoverable issue. The operator will inspect the logs and trigger a new round.

**There is no graceful silent exit.** If you don't call one of the two, the dashboard's Versions tab will stay \`draft\`/\`pending\` forever — that's a bug, not a feature. When in doubt, call \`ds_publish_version\` — at worst it skips, never fails silently.`);

  sections.push(`## Reminders

- **Subordinate spawn**: each \`spawn_subordinate_agent\` call must include the role name (e.g. \`'extractor'\`) — the orchestrator looks up provider/model/skills from your roster automatically. **Skills are template-locked**: do NOT pass a \`skills\` array, do NOT instruct the subordinate to "load" or "fetch" the skill — the skill markdown is already in their system prompt by the time they boot.
- **Task descriptions are critical**: subordinates DO NOT see this prompt. They see ONLY the task you write. Make every task concrete with: (a) the exact directory to read first (\`./design_system/\` or \`./pkg/\`), (b) the exact files to produce, (c) the DS tools to call (\`ds_record_component\`, etc.), and (d) when to submit_plan_to_master to signal completion.
- **Wait pattern**: prefer \`wait_for_subordinates({ ids: [...] })\` over polling. The MasterAttention bus wakes you when subordinates finish.
- **Board posts**: post short status updates with \`post_to_board\` so the dashboard's Activity feed shows progress.
- **Do not edit code yourself.** Master is orchestrator only — subordinates do all file work.`);

  if (extraInstructions !== '') {
    sections.push(`## Operator instructions for this round\n\n${extraInstructions}`);
  }

  sections.push(`## START NOW`);

  return sections.join('\n\n');
}
