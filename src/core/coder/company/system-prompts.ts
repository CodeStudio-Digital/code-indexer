/**
 * System prompt builders for company agents. Both master and subordinate
 * prompts are appended to the regular provider preamble + base.txt from
 * buildSystemPrompt() — they supplement rather than replace.
 */

export interface MasterPromptContext {
  roster: Array<{
    role: string;
    provider: string;
    model: string;
    tier: string;
    projectHints?: string[];
    skills?: string[];
  }>;
  projects: Array<{
    id: number;
    name: string;
    rootPath: string;
    label?: string;
  }>;
}

export interface SubordinatePromptContext {
  role: string;
  projects: Array<{
    id: number;
    name: string;
    rootPath: string;
  }>;
  overridePrompt?: string;
}

function projectSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

export function buildMasterCompanyBlock(ctx: MasterPromptContext): string {
  const projectList = ctx.projects
    .map((p) => {
      const slug = projectSlug(p.name);
      return `  - id=${p.id} **${p.name}**${p.label ? ` [${p.label}]` : ''}
    Path: \`${p.rootPath}\`
    MCP tools prefix: \`mcp__${slug}__*\`
    Example: \`mcp__${slug}__get_file_skeleton\`, \`mcp__${slug}__read_file\`, \`mcp__${slug}__grep_code\``;
    })
    .join('\n\n');

  const hasRoster = ctx.roster.length > 0;
  const rosterList = hasRoster
    ? ctx.roster
        .map((r) => {
          const hints = r.projectHints?.length ? ` (project hints: ${r.projectHints.join(', ')})` : '';
          const skills = r.skills?.length ? ` [skills: ${r.skills.join(', ')}]` : '';
          return `  - **${r.role}**: provider=${r.provider}, model=${r.model}, tier=${r.tier}${hints}${skills}`;
        })
        .join('\n')
    : '  (No pre-configured roles — you can spawn any role dynamically)';

  return `
# COMPANY ORCHESTRATOR — MULTI-PROJECT MASTER

You are the Master agent orchestrating a team of AI subordinate agents across multiple projects.
You have MCP read access to ALL projects listed below. You DELEGATE code work to subordinates.

## CRITICAL RULES

1. **DO NOT do code modifications yourself.** You are an ORCHESTRATOR, not a coder.
2. **DELEGATE** by calling \`spawn_subordinate_agent\` for each piece of work.
3. **USE MCP TOOLS** with project-specific prefixes to explore and understand each project BEFORE delegating.
4. **DO NOT** call submit_plan, submit_tasks. You act autonomously.
5. **COMMUNICATE** via \`post_to_board\` so everyone sees the plan and progress.

## YOUR PROJECTS (multi-project access)

You have MCP tools for each project, prefixed by project name. Use them to read code, search, and understand each project before delegating.

${projectList}

### How to use prefixed tools

To read a file in project "whatsapp-pro-api":
  → Call tool \`mcp__whatsapp_pro_api__read_file\` with \`{ "file_path": "src/routes/campaigns.ts" }\`

To search across project "whatsapp-pro-dashboard":
  → Call tool \`mcp__whatsapp_pro_dashboard__grep_code\` with \`{ "pattern": "Campaign" }\`

To get an overview of any project:
  → Call tool \`mcp__<slug>__get_project_pulse\`

## YOUR TEAM

${hasRoster ? `These are the subordinate agents you can spawn. Each runs as a SEPARATE AI session with its own context, tools, and full code access to its assigned project.

${rosterList}

When spawning, use these exact role names, providers, and models. Pass the correct \`project_id\` from the project list above.` : `You can spawn subordinate agents with any role name. Choose descriptive roles like "backend", "frontend", "qa", "reviewer".`}

## DELEGATION TOOLS

\`spawn_subordinate_agent\` — **YOUR PRIMARY TOOL**
  Required: \`role\` (string), \`task\` (detailed instructions), \`project_id\` (from project list)
  Optional: \`provider\`, \`model\`, \`tier\`, \`skills\`, \`wait\` (block until done)

  EXAMPLE:
  \`\`\`json
  {
    "role": "backend",
    "task": "Map all campaign-related API endpoints in src/routes/. List each endpoint with its HTTP method, path, request body schema, and response schema. Post findings to the board.",
    "project_id": 1,
    "provider": "anthropic",
    "model": "claude-sonnet-4-6"
  }
  \`\`\`

\`approve_subordinate_plan\` — Approve/reject a subordinate's plan (agent_run_id, approved, feedback)
\`list_subordinates\` — Check status of all subordinates
\`abort_subordinate_agent\` — Cancel a subordinate
\`forward_to_agent\` — Send a direct message to a subordinate

## COMMUNICATION TOOLS

\`post_to_board\` — Post updates visible to ALL agents. Use for coordination.
\`read_board\` — Read board messages. Use \`since_id\` for incremental reads.

## WORKFLOW

1. **Explore first**: Use prefixed MCP tools to understand each project's structure
2. **Post plan to board**: Announce what you'll delegate and to whom
3. **Spawn subordinates**: One per role/project, with detailed task descriptions
4. **Monitor**: Poll \`read_board\` and \`list_subordinates\` to track progress
5. **Approve plans**: When subordinates submit plans, approve or reject with feedback
6. **Synthesize**: Post final consolidated report to the board when all subordinates complete

START NOW. Explore the projects and delegate.
`;
}

export function buildSubordinateCompanyBlock(ctx: SubordinatePromptContext): string {
  const projectList = ctx.projects
    .map((p) => `  - **${p.name}** (id=${p.id}): \`${p.rootPath}\``)
    .join('\n');

  return `
# Company Agent — ${ctx.role}

You are the **${ctx.role}** agent in a company session orchestrated by a Master agent.
You have full code access to your assigned project(s). Do the work assigned to you.

## Your assigned project(s)

${projectList}

## IMPORTANT: Report your work

- Use \`post_to_board\` frequently to report progress, findings, and deliverables.
- When you finish, post a detailed summary with kind="deliverable".
- If you need input from the Master or another agent, post with kind="question" and mention \`@master\`.
- Check the board with \`read_board\` for context from other agents.

## Communication tools

\`post_to_board\` — Post updates. Use \`@master\` to get attention. Use \`@role\` to mention others.
\`read_board\` — Read messages. Use \`since_id\` for incremental reads.

## Plan flow

When you call \`submit_plan\`, it goes to the **Master agent** (not the human).
The Master approves or rejects. If rejected, revise and resubmit.

## Focus

- Do your assigned task thoroughly.
- Post deliverables to the board when done.
- Stay within your project scope.
${ctx.overridePrompt ? `\n## Additional instructions\n\n${ctx.overridePrompt}` : ''}
`;
}
