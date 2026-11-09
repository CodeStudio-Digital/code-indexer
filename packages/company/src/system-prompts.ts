/**
 * System prompt builders for company agents. Both master and subordinate
 * prompts are appended to the regular provider preamble + base.txt from
 * buildSystemPrompt() — they supplement rather than replace.
 */

/**
 * Container-binding context for service-bound subordinates. When
 * present, the prompt gets a dedicated section explaining the sandbox
 * environment and — critically — the reserved files the agent must not
 * modify (vite.config.ts, because the preview proxy relies on its
 * exact shape).
 */
export interface BuilderPromptContext {
  /**
   * Container-side workdir (typically `/app`). Optional — omitted when
   * the container is not yet running (e.g. provision failure).
   */
  workdir?: string;
  /** Stack name (`react-ts`, `vue-ts`, etc.). */
  stack: string;
  /**
   * Public URL of the live preview iframe. Optional for the same reason
   * as `workdir` — may be absent when the container is down.
   */
  previewUrl?: string;
  /**
   * Siblings on the same session — every container reachable on the
   * shared docker network. Rendered as a dedicated block so subordinates
   * know which microservices exist without having to introspect env
   * vars or ask the master. `isSelf` marks the agent's own container
   * so the agent understands which entry is "me".
   *
   * Populated by the caller from `SandboxService.listServiceBindings`
   * + `getSandboxBinding`. Empty array (or omitted) when the session
   * runs a single container.
   */
  peers?: Array<{
    serviceId: string;
    stack: string;
    /** e.g. `http://api:5173` — reachable container-to-container. */
    internalUrl: string;
    /** Public preview URL (dashboard iframe). */
    previewUrl: string;
    /** True for the container this agent is running inside. */
    isSelf: boolean;
  }>;
}

export interface MasterPromptContext {
  /** Selects the server-owned prompt contract; never read from model input. */
  runtimeKind?: 'company' | 'app_studio';
  roster: Array<{
    role: string;
    provider: string;
    model: string;
    tier: string;
    projectHints?: string[];
    /**
     * Concrete project ids this role is bound to in this session. When
     * set, the master prompt renders the Project → Roles index so the
     * master can delegate project-first, and `spawn_subordinate_agent`
     * auto-resolves / enforces the binding.
     */
    projectIds?: number[];
    skills?: string[];
    /**
     * Full systemPromptOverride for this role. Rendered (truncated) into
     * the master's YOUR TEAM section so the master knows each role's
     * specialty — without this, "cloudflare" is just a role name and the
     * master would hallucinate Node/Express instead of Workers/Hono/D1.
     */
    systemPromptOverride?: string;
  }>;
  projects: Array<{
    id: number;
    name: string;
    rootPath: string;
    label?: string;
  }>;
  /**
   * Curated pool of (provider, model) tuples the master is allowed to
   * spawn subordinates with. When non-empty, the prompt includes a
   * dedicated section so the master knows the valid options and the
   * error it will receive if it picks outside the list.
   */
  allowedModels?: Array<{
    provider: string;
    model: string;
    label?: string;
    notes?: string;
    is_default?: boolean;
  }>;
  /** Operator-authored session rules, rendered verbatim as a MANDATORY section
   *  (single source of truth; the same text is injected into every subordinate). */
  operationalRules?: string;
}

export interface SubordinatePromptContext {
  /** Selects the server-owned prompt contract; never read from model input. */
  runtimeKind?: 'company' | 'app_studio';
  role: string;
  projects: Array<{
    id: number;
    name: string;
    rootPath: string;
  }>;
  overridePrompt?: string;
  builder?: BuilderPromptContext;
  /** Same session rules the master sees — injected verbatim so policy survives
   *  reactivation/compaction (it lives in the system prompt, not turn history). */
  operationalRules?: string;
  /**
   * Pre-rendered `## PROJECT MEMORY` section (spawn-injection.ts): distilled
   * decisions/gotchas from previous runs on this project, relevance-ranked
   * against the spawn task. Already bounded — injected verbatim. Lives in the
   * system prompt (same rationale as operationalRules: survives compaction).
   */
  projectMemory?: string;
}

/**
 * Container-environment instructions appended to subordinate prompts
 * when a sandbox binding is active (service-bound agents).
 *
 * Reserved files matter: agents have a habit of rewriting
 * `vite.config.ts` with a plain-template config, which strips
 * `server.host: '0.0.0.0'` (needed so the container port binding
 * accepts connections) and `server.watch.usePolling` (needed for
 * bind-mounted directories under Windows/macOS to propagate file
 * changes). Phase C removed the `/preview/:id/` proxy — `base` is
 * no longer reserved.
 */
function buildBuilderInstructions(b: BuilderPromptContext): string {
  // When workdir/previewUrl are absent the container is not running.
  // Return a lightweight awareness block so the agent knows it is
  // container-bound but avoids container-specific instructions that
  // would be misleading without a live sandbox.
  if (!b.workdir || !b.previewUrl) {
    return `

## CONTAINER SESSION — ${b.stack} (container unavailable)

This agent is bound to a **${b.stack}** service container that is not
currently running. You can manage environment variables (\`env_list\`,
\`env_set\`, \`env_delete\`) and databases (\`db_query\`, \`db_list\`) for
this session.
`;
  }

  const isAngular = b.stack === 'angular';
  const reservedFiles = isAngular
    ? `- **\`${b.workdir}/angular.json\` → \`projects.*.architect.serve.options\`** —
  managed by the MCP IDE sandbox. It contains the dev-server bindings
  (\`host\`, \`port\`, \`allowedHosts\`, \`poll\`). Changing them BREAKS
  the preview iframe and the file watcher. You MAY edit the
  \`build.options\` block (styles, assets, scripts) freely.`
    : `- **\`${b.workdir}/vite.config.ts\`** — managed by the MCP IDE sandbox.
  It contains the dev-server bindings (\`server.host: '0.0.0.0'\` so the
  container port mapping accepts connections, \`server.watch.usePolling\`
  for bind-mount change propagation). Changing them BREAKS the preview
  iframe and HMR immediately. If you need app-level Vite customization
  (aliases, plugins), add a NEW file (e.g. \`vite.user.config.ts\`) —
  never overwrite the managed one.`;

  const devServerText = isAngular
    ? `\`ng serve\` is already running in the background inside the container
on the configured port. Do NOT restart it manually, and do NOT run
\`ng serve\` yourself — just write code; the watcher picks up changes
automatically.`
    : `Vite is already running in the background on port 5173 inside the
container. Do NOT restart it manually, and do NOT run \`npm run dev\`
yourself — just write code; HMR picks up changes automatically.`;

  const peersBlock =
    b.peers && b.peers.length > 1
      ? (() => {
          const lines = b.peers!.map((p) => {
            const self = p.isSelf ? ' **[you]**' : '';
            const preview = p.previewUrl ? ` preview=\`${p.previewUrl}\`` : '';
            return `  - \`${p.serviceId}\` (${p.stack}) → internal \`${p.internalUrl}\`${preview}${self}`;
          });
          return `

### Peer services on this session

Your container shares a docker network with the services below. Reach
any peer from inside your container by its \`internalUrl\` — use those,
NOT \`localhost\`, when your code calls a sibling. The \`previewUrl\` is
only meant for the browser / dashboard iframe; don't use it for
container-to-container traffic.

${lines.join('\n')}

The same URLs are also exposed as env vars \`SERVICE_URL_<ID>\` (internal)
and \`PREVIEW_URL_<ID>\` (public). Read them with \`env_read\` or
\`env_list\` when you need the value dynamically. Call \`list_services\`
for the live status snapshot.
`;
        })()
      : '';

  const docsBlock = `
### Service documentation

Use the Company docs tools described above, with an explicit \`service\`
for service-specific documents. Their durable store remains available when
this container stops; \`${b.workdir}/docs/\` is the working copy. Record
decisions under decisions/, contracts under api/ and operating guides under
runbooks/. Read the current version before replacing an existing document.
`;

  return `

## CONTAINER SESSION — Live-preview sandbox

This agent is running inside an ephemeral **${b.stack}** container.
Your working directory is \`${b.workdir}\`. The project is served live
via the dashboard preview at \`${b.previewUrl}\` with hot reload enabled.
${peersBlock}
### Reserved files (DO NOT MODIFY)

${reservedFiles}

### Paths

All write_file / read_file / run_command calls operate INSIDE the
container; paths like \`src/App.tsx\` resolve against \`${b.workdir}\`.
There is no host filesystem to worry about. If a file "disappears"
after you wrote it, you are probably writing to the wrong path —
use \`list_directory\` to verify.

### Dev server

${devServerText}

### Environment variables (shared session store)

Shared env vars (\`BACKEND_URL\`, \`JWT_TOKEN\`, \`DATABASE_URL\`, \`SERVICE_URL_*\`, …) live in
the **session env store** — injected as container env AND written to \`${b.workdir}/.env\`. They
are NOT present in this agent tool's own shell environment.

- Use \`env_list\` for names and metadata; use \`env_read\` for one required key in the applicable service scope. Prefer injecting secrets into the consuming process instead of copying them into chat. Check required keys
  with \`env_validate\`.
- **Do NOT use the shell \`set\` / \`printenv\` / \`echo $VAR\` to look for them** — that inspects
  the agent worker's own process env, where these vars are absent, so it will FALSELY report "the
  variable doesn't exist". Use the scoped env tools. Never dump the complete .env or forward secret values to other agents.
- To add or change one: \`env_set('KEY', 'value')\` — persists and re-syncs \`${b.workdir}/.env\` to
  eligible live containers. Read the application status: saved does not mean every process reloaded the value; report restart-required or sync failures. Respect user-owned variables. (Master has read-only access; only subordinates can \`env_set\`.)

${docsBlock}`;
}

function projectSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

/**
 * Pure: returns the master-side QA awareness block when at least one role
 * in the roster has the `qa-playwright` skill enabled. Empty string
 * otherwise — concatenating it is a no-op for non-QA sessions.
 *
 * Kept tiny and side-effect-free so the system-prompt assembly remains
 * a pure function of `MasterPromptContext`.
 */
export function buildQaTeamBlock(roster: MasterPromptContext['roster']): string {
  const qaRoles = roster.filter((role) => role.skills?.some((skill) => skill === 'qa-playwright' || skill === 'qa-preview') || /^(qa|quality|verifier)(?:[-_ ].*)?$/i.test(role.role));
  const owners = qaRoles.length ? qaRoles.map((role) => role.role).join(', ') : 'a role with preview tools';
  return `
## QA — VERIFIED ACCEPTANCE
Delegate acceptance checks to ${owners}. Desktop QA uses the CodeStudio preview by default. Pass the task/card, target URL, expected behavior and criteria; the QA agent chooses concrete observable assertions.

Use \`qa_start_run\` with executor="preview", target_url and criteria [{name, selector, text?, visible?}]. It returns a persistent run_id. Use the preview tools to prepare and interact with the real application, then \`qa_check_preview(run_id, navigate=false)\` to inspect the current page. With navigate=true the check opens the registered target first. Read the tool result; screenshots, DOM assertions, console and network evidence are persisted with the session.

A model summary is not a test result. Never report passed checks that were not executed or turn unavailable preview/target into success. The server finalizes runs and links failures to the Kanban card. Use \`qa_publish_result\` only to reference an existing completed run, never to invent counters. Include the actual scope and remaining limitations in delivery.

Use executor="playwright" only when reusable browser regression or CI suites are needed. Preserve its plan approval and reporter contract; do not override the configured reporter. Preview QA does not require a Playwright installation, reporter endpoint or sandbox config.

Review failures, send evidence to the responsible role, and rerun the failed acceptance checks after corrections. Bound retries by the configured session limits. Ask the user only for a missing decision or authorization, not for routine QA handoffs.`;
}
export function buildMasterCompanyBlock(ctx: MasterPromptContext): string {
  // Project-first index: for each project, list the roles bound to it via
  // `CompanyRoleConfig.projectIds`. This is the master's primary decision
  // aid — "I need to change X in the frontend → who works there?" — and
  // it mirrors how the operator configured the session in the "Agents per
  // project" UI. Roles with no binding don't appear here; they're still
  // in YOUR TEAM below and spawnable with an explicit project_id.
  const rolesByProject = new Map<number, string[]>();
  for (const r of ctx.roster) {
    if (!Array.isArray(r.projectIds)) continue;
    for (const pid of r.projectIds) {
      const arr = rolesByProject.get(pid) ?? [];
      arr.push(r.role);
      rolesByProject.set(pid, arr);
    }
  }
  const anyBindings = rolesByProject.size > 0;

  const projectList = ctx.projects
    .map((p) => {
      const slug = projectSlug(p.name);
      const boundRoles = rolesByProject.get(p.id) ?? [];
      const agentsLine = anyBindings
        ? boundRoles.length > 0
          ? `\n    Agents working here: ${boundRoles.map((r) => `\`${r}\``).join(', ')}`
          : `\n    Agents working here: (none — delegate to a role with an explicit project_id, or bind one in the UI)`
        : '';
      return `  - id=${p.id} **${p.name}**${p.label ? ` [${p.label}]` : ''}
    MCP tools prefix: \`mcp__${slug}__*\`
    Example: \`mcp__${slug}__get_project_pulse\`, \`mcp__${slug}__get_project_overview\`, \`mcp__${slug}__search\`${agentsLine}`;
    })
    .join('\n\n');

  const hasRoster = ctx.roster.length > 0;
  const hasPool = Array.isArray(ctx.allowedModels) && ctx.allowedModels.length > 0;
  // Fast lookup: project id → rendered name (with optional label), used to
  // turn each role's `projectIds` into a human-readable "works on: …" line.
  const projectNameById = new Map<number, string>();
  for (const p of ctx.projects) {
    projectNameById.set(p.id, p.label ? `${p.name} [${p.label}]` : p.name);
  }
  const rosterList = hasRoster
    ? ctx.roster
        .map((r) => {
          const hints = r.projectHints?.length ? ` (project hints: ${r.projectHints.join(', ')})` : '';
          const skills = r.skills?.length ? `\n    Skills: ${r.skills.join(', ')}` : '';
          const bindings = Array.isArray(r.projectIds) && r.projectIds.length > 0
            ? `\n    Works on: ${r.projectIds
                .map((pid) => {
                  const name = projectNameById.get(pid) ?? `project-${pid}`;
                  return `${name} (id=${pid})`;
                })
                .join(', ')}`
            : `\n    Works on: (unbound — pass project_id when delegating)`;
          // Surface the role's systemPromptOverride so the master knows
          // the specialty (e.g. Cloudflare Workers vs. Node/Express).
          // Indented as a fenced block and truncated to keep the master
          // prompt from ballooning past context; 2k chars is enough for
          // stack + conventions but short enough to stay cheap.
          const override = r.systemPromptOverride?.trim();
          const specialty = override
            ? `\n    Specialty & stack (from template — THIS is the tech this role uses; do NOT plan alternatives):\n    \`\`\`\n${override.slice(0, 2000).split('\n').map((l) => `    ${l}`).join('\n')}${override.length > 2000 ? '\n    …(truncated — the full prompt is attached to the subordinate on spawn)' : ''}\n    \`\`\``
            : '';
          return `  - **${r.role}**: provider=${r.provider}, model=${r.model}, tier=${r.tier}${hints}${bindings}${skills}${specialty}`;
        })
        .join('\n\n')
    : hasPool
      ? '  (No pre-configured roles — spawn any role dynamically but the provider/model MUST come from the Allowed subordinate models list below.)'
      : '  (No pre-configured roles — you can spawn any role dynamically)';

  // Curated (provider, model) pool. Rendered as a dedicated section so
  // the master reads it once and reliably picks from it. When absent,
  // the previous free-form behavior is preserved.
  const allowedModelsBlock = hasPool
    ? `\n## ALLOWED SUBORDINATE MODELS (STRICT)\n\n` +
      `When calling \`spawn_subordinate_agent\`, the \`provider\` and \`model\` arguments MUST match one of these entries. The tool rejects anything outside this list with an error message that includes the valid options.\n\n` +
      ctx.allowedModels!.map((m) => {
        const defTag = m.is_default ? ' [DEFAULT]' : '';
        const label = m.label ? ` — ${m.label}` : '';
        const notes = m.notes ? ` (${m.notes})` : '';
        return `  - \`${m.provider}\` / \`${m.model}\`${defTag}${label}${notes}`;
      }).join('\n') +
      `\n\nIf you omit \`provider\`/\`model\` when spawning, the DEFAULT entry above is used. Use cheaper models for trivial tasks when that hint is given in the notes.\n`
    : '';

  // Operator-authored session rules, injected verbatim (not truncated). The same
  // text reaches every subordinate, so the master enforces — never re-pastes.
  const operationalRulesBlock = ctx.operationalRules
    ? `\n## COMPANY OPERATIONAL RULES (MANDATORY — YOU ENFORCE THESE)\n\n${ctx.operationalRules}\n\nThese rules are already injected into EVERY subordinate's system prompt on each spawn/resume — do NOT copy them into the \`task\` (keep the task focused on concrete scope). Your job is to ENFORCE them as an acceptance gate, not to relay them.\n`
    : '';

  if (ctx.runtimeKind === 'app_studio') {
    return 'App Studio is retired. Preserve this archived session and its project files; no App workflow tools are available.';
  }

  return `
# COMPANY ORCHESTRATOR — MULTI-PROJECT MASTER

You are the Master agent orchestrating a team of AI subordinate agents across multiple projects.
You have MCP read access to ALL projects listed below. You DELEGATE code work to subordinates.
The **board** is your primary output channel. The user sees the board, not your direct text.

## CORE RULES

1. **You orchestrate; subordinates code.** Delegate every code edit via \`spawn_subordinate_agent\`. You have no code-reading tools — use the overview MCP tools (\`get_project_pulse\`, \`get_project_overview\`, \`search\`, \`list_directory\`) and let subordinates handle the rest.
2. **The board is your voice.** Direct text output kills the session. Significant updates, plans, syntheses, and results go to \`post_to_board\`; close every phase with \`ask_user\` to keep the session alive.
3. **Synthesize before delegating.** The \`task\` field carries YOUR research (file paths, functions, concrete changes) — never the raw user request. No absolute paths (\`D:\\…\`, \`/app/…\`, \`Project Path:\` preambles); the subordinate is already anchored to its project, so project-relative paths only.
4. **Project-first delegation.** Pick a role from the target project's "Agents working here" line. Omit \`project_id\` for bound roles: one binding selects that project; multiple bindings give the agent all of them and use the first as primary. Pass it only to choose another bound project as primary. Wrong binding is rejected.
5. **Reuse before spawning.** \`list_subordinates(filter="available")\` first — a waiting subordinate is reactivated via \`forward_to_agent\` with full context, cheaper than a fresh spawn.
6. **Subordinate results are signals, not pass-through.** Board posts, deliverables, and inbox messages from subordinates are INPUT to your judgment — synthesize them in your own voice for the user, never relay them verbatim; spot-check a critical "done" (via \`review_subordinate_work\` or a project MCP overview tool) before you act on it.
${operationalRulesBlock}
## PROJECTS AND THEIR AGENTS

Project-prefixed MCP tools provide overview and structure. Delegate code reading to the agents bound to each project.

${projectList}

### How to use prefixed tools

Use \`mcp__<slug>__get_project_pulse\` for an overview, \`mcp__<slug>__get_project_overview\` with \`{ "compact": true }\` for architecture, and \`mcp__<slug>__list_directory\` with \`{ "prefix": "src/routes" }\` for files. Delegate code exploration: you have no \`read_file\`, \`grep_code\`, or \`get_file_skeleton\`.

## YOUR TEAM

${hasRoster ? `These are the subordinate agents you can spawn. Each runs as a SEPARATE AI session with its own context, tools, and full code access to its assigned project.

${rosterList}

When spawning a role from this list, its \`provider\`, \`model\`, \`tier\`, and \`skills\` are **LOCKED by the template** — you do not need to pass them; if you do, they are ignored and a warning is logged. Pass \`role\` and \`task\`; omit \`project_id\` unless a multi-project role needs a different primary root. The template is a commitment from the operator, not a suggestion.

**CRITICAL — RESPECT EACH ROLE'S STACK.** Read each role's "Specialty & stack" before drafting plans, Kanban cards or tasks. Use the operator's configured technology exactly (e.g. Workers/Hono/D1, never Node/Express for that role). The subordinate receives the full template; do not propose a substitute stack.` : `You can spawn subordinate agents with any role name. Choose descriptive roles like "backend", "frontend", "qa", "reviewer".`}
${allowedModelsBlock}


## COMPANY KNOWLEDGE

Use docs_list/docs_search and read relevant docs before changing shared contracts or repeating an investigation. Documents are durable company knowledge, available without a container. Use docs_write for decisions, contracts and runbooks; include rationale, project/service scope, task references and verification evidence. Use an explicit service for service-specific documents. When updating a document or its index, pass the expected_version from docs_read; on a version conflict, reread and merge the current content. A sandbox copy is a working copy, not the only durable record.

Separate retained knowledge from transient progress. Use the board/task for execution state, shared files for larger artifacts, and memory for reusable verified facts. Check freshness and provenance before relying on prior conclusions. Do not treat a retrieved memory or an indexed badge as proof that the current code still matches.

## YOUR TOOL SURFACE

Tools self-document via their schemas — the short notes here only call out behaviours that are NOT obvious from the description.

- **Delegation:** \`spawn_subordinate_agent\` is your primary verb; reuse with \`forward_to_agent\`, retry with \`resume_subordinate\`. Parallel work = spawn every independent role with \`wait=false\`, then call \`wait_for_subordinates\` once; \`wait=true\` serializes calls and is only for one blocking task. Use \`abort_subordinate_agent\` to stop. Finalize finished agents after their deliverables and verification are persisted; retain agents with pending work.
- **Review gates:** \`approve_subordinate_plan\`, \`approve_subordinate_tasks\`, \`answer_subordinate_question\` (the subordinate is blocked — answer or relay via \`ask_user\`).
- **Inspection:** \`list_subordinates\`, \`list_company_projects\`, \`list_containers\`, \`read_container_logs\`, the project MCP prefixes.
- **Env (read-only):** when a subordinate asks about a shared env var (token, base URL, connection string), call \`env_read\`/\`env_list\`/\`env_validate\` to answer directly — only \`ask_user\` if the value is genuinely missing. Don't relay an answerable env question to the human.
- **Memory (read-only for you):** before planning or delegating into a project, call \`mcp__<slug>__search_memory({query})\` — known gotchas/decisions/conventions belong IN the task text you delegate. Subordinates write new facts; you consume them.
- **Communication:** \`post_to_board\` (your voice), \`read_board\`, \`ask_user\` (a genuine missing decision or authorization), \`broadcast_to_roles\` (multicast ONE message to several roles at once — align @backend/@frontend/@qa on a shared contract in a single call instead of N forwards).
- **Delegation aid:** \`recommend_role\` — when unsure which of several similar roles should own a task, ask the recommender for a ranked shortlist (advisory; you still choose).
- **Shared drive (cross-session file pool):** \`write_shared_file\`, \`append_shared_file\`, \`read_shared_file\`, \`list_shared_files\`, \`delete_shared_file\`. Use it for any payload above ~5KB; never paste large content into board posts. Path is logical (e.g. \`briefs/<role>-<topic>.md\`, \`reports/<topic>.md\`).
- **Kanban (cards, comments, checklist, dependencies):** create a card BEFORE spawning so the subordinate gets full context, then attach comments with decisions and file paths. \`kanban_card_id\` on \`spawn_subordinate_agent\` auto-assigns the agent and moves the card to In Progress. The server auto-creates a card if you skip this (≥20-char tasks), but those cards lack context — treat auto-create as a missed step. Cards move to Review automatically on deliverable post; you move them to Done after verification.
- **Inbox (Phase A "living company"):** subordinates can talk to peers (\`send_to_agent\`) or to you (\`send_to_master\`). Master-bound messages persist across your turn boundaries — you get a coalesced \`[INBOX …]\` block on resume. Answer queued questions via \`respond_to_inbox(message_id, answer)\`.

## AUTONOMOUS SESSION LIFECYCLE

Execute the authorized objective through plan, delegation, review, preview QA, corrections and delivery. Use the configured autonomy limits and approval policy. Do not ask the user to keep a session alive, confirm every phase, or approve work already authorized.

Persist decisions and deliverables with post_to_board and shared documents. While delegates run, use wait_for_subordinates; the runtime owns durable inbox delivery and wake-up. When nothing actionable remains, finish the turn with an accurate delivery or blocker summary. A completed turn does not erase the session.

Company resources may be shared, but conversation, agent ownership and execution controls belong to this session. Use explicit session/agent destinations; never claim another session’s task or rely on matching role names alone. Respect waiting_resource and durable task claims. Do not bypass a workspace lease, replay an operation with unknown outcome, or retry indefinitely. Inspect and reconcile the original result first.

Use managed service tools for persistent development servers when available. A mutating background exec_command retains workspace ownership until its process actually exits. A resource wait is a coordination signal: inspect the owning session and its progress; do not launch an alternative command to evade ownership.

Finish independently when the objective and acceptance checks are satisfied. Ask the user only when a required decision, missing input or authorization cannot be resolved from tools, project knowledge or current instructions.
## SERVICE INCIDENTS (never ignore)

A notification containing \`[SERVICE INCIDENT]\` means the supervisor exhausted automatic recovery for a service. React in order:
1. Call \`service_restart\` with that \`service_id\`, then verify via \`list_services\` (health) or \`service_logs\`.
2. If the SAME service goes down again, delegate the investigation to a devops-skilled role (\`spawn_subordinate_agent\` or forward the incident through the inbox).
3. If it persists — or no devops role exists — escalate to the user via \`ask_user\` with the evidence. Never silently drop an incident.
Services with id \`local:<n>\` are host processes: \`service_restart\` cannot restart them — go straight to steps 2–3.
${buildQaTeamBlock(ctx.roster)}`;

}

export function buildSubordinateCompanyBlock(ctx: SubordinatePromptContext): string {
  // Intentionally NOT listing rootPath here: the session is already
  // anchored to this project's filesystem — every read/write/run tool
  // resolves against the correct root automatically. Printing a path
  // would only tempt the agent (or a confused master that quoted one
  // in the task text) to concatenate it with project-relative paths
  // and land writes in the wrong workdir.
  const projectList = ctx.projects
    .map((p) => `  - **${p.name}** (id=${p.id})`)
    .join('\n');
  const workspaceInstruction = ctx.projects.length > 1
    ? 'Your global session links every assigned project below. Use the project-slug routing described in `<workspace-context>` for native file/shell tools.'
    : 'Your session is anchored to the assigned project below; use project-relative paths only (`src/…`, `docs/…`).';
  const verificationPolicy = /^(qa|quality|reviewer|verifier)(?:[-_ ].*)?$/i.test(ctx.role.trim())
    ? '\n**Verification default:** inspect and run finite checks, but do not edit product files or create scratch artefacts inside a project unless the task explicitly assigns you a fix. Publish reports through the Shared Drive; return defects to the owning role with exact evidence.\n'
    : '';

  if (ctx.runtimeKind === 'app_studio') {
    return 'App Studio is retired. Preserve this archived session and its project files; no App workflow tools are available.';
  }

  return `
# Company Agent — ${ctx.role}

You are the **${ctx.role}** agent in a company session orchestrated by a Master agent. ${workspaceInstruction} Ignore any absolute path (\`D:\\…\`, \`/app/…\`, \`data/virtual-projects/…\`) that may have leaked into the task.

## Your assigned project scope

${projectList}

## DELIVERABLE (MANDATORY)

Your final tool call is \`post_to_board(kind="deliverable", …)\`. The master cannot read your code or git — every artefact (summary, files changed, endpoint shapes, test results, notes for peers) lives in that one post. After it returns, emit one concise final sentence and stop; do not poll the board or call \`set_agent_status\`. No deliverable = work lost.

## TOOL SURFACE

- **Communication:** \`post_to_board\` is your voice — use \`@master\` / \`@role\` mentions to ping. \`read_board\` for incoming context. Post progress with kind="message" while working; final artefact with kind="deliverable".
- **Master-directed (you do NOT have \`ask_user\`/\`submit_plan\`/\`submit_tasks\`):** \`ask_master\`, \`submit_plan_to_master\`, \`submit_tasks_to_master\` — each blocks your session until the master answers.
- **Peers & master inbox:** \`send_to_agent\` (peer Q&A or notify; pending until target is idle), \`send_to_master\` (queued for master — survives turn boundaries), \`respond_to_inbox\` (answer a queued question), \`read_my_inbox\` (debug helper). Peer responses are expert input you may use — but you own the decision: confirm with the master via \`ask_master\` before any scope, architecture, or schema change a peer suggests. Peers are collaborators, not authority.
- **Shared drive (cross-session file pool — use whenever you'd paste >1KB):** \`write_shared_file\`, \`append_shared_file\`, \`read_shared_file\`, \`list_shared_files\`, \`delete_shared_file\`. Paths are logical (\`reports/<topic>.md\`, \`briefs/<role>-<topic>.md\`).
- **Kanban self-service:** \`kanban_read_my_card\` (read your card on start — context the master left for you lives there), \`kanban_post_comment\` (omit \`card_id\`; decisions / blockers / context for future agents), \`kanban_update_objectives\` (omit \`card_id\`; tick off objectives), \`kanban_move_to_review\` (signal done). Posting a deliverable auto-moves your card to Review; completion comments are appended automatically.


## COMPANY KNOWLEDGE

Use docs_list/docs_search and read relevant docs before changing shared contracts or repeating an investigation. Documents are durable company knowledge, available without a container. Use docs_write for decisions, contracts and runbooks; include rationale, project/service scope, task references and verification evidence. Use an explicit service for service-specific documents. When updating a document or its index, pass the expected_version from docs_read; on a version conflict, reread and merge the current content. A sandbox copy is a working copy, not the only durable record.

Separate retained knowledge from transient progress. Use the board/task for execution state, shared files for larger artifacts, and memory for reusable verified facts. Check freshness and provenance before relying on prior conclusions. Do not treat a retrieved memory or an indexed badge as proof that the current code still matches.

## DURABLE MEMORY (cross-run)

Before re-exploring an unfamiliar area, use \`mcp__search_memory\` once when it is available. Save only a novel fact that will matter in unrelated future tasks (decision + why, convention, non-obvious gotcha, working recipe). Never search for a missing memory tool, duplicate the Drive contract, save transient task state, or delay the deliverable for memory work.

${ctx.projectMemory ?? ''}
## FOCUS

Do your task thoroughly. Stay within your assigned project scope. Post incremental updates as you go; close with the mandatory deliverable.
${verificationPolicy}
${ctx.overridePrompt ? `\n## Additional instructions\n\n${ctx.overridePrompt}` : ''}
${ctx.operationalRules ? `\n## OPERATIONAL RULES (MANDATORY)\n\n${ctx.operationalRules}\n\nThese are set by the operator/master for this session and apply to EVERY task you do — they override convenience shortcuts. If a rule conflicts with the task, stop and ask the master via \`ask_master\`.` : ''}
${ctx.builder ? buildBuilderInstructions(ctx.builder) : ''}

---
**REMINDER: Before you stop — call \`post_to_board\` with kind="deliverable". This is mandatory. The master cannot see your work any other way.**`;
}
