/**
 * create_skill — author or update a reusable skill from inside a session.
 *
 * Deterministic counterpart to the `skill-creator` builtin skill (which owns
 * the LLM-driven interview + body authoring). This tool does the mechanical,
 * verifiable work: validate the id and tool names, run a trigger eval
 * (`skill-trigger-eval.ts`), and persist via `SkillStore.upsertSkill`.
 *
 * `dry_run: true` returns the validation + trigger report WITHOUT persisting,
 * so the orchestrating skill can iterate on triggers/description before
 * committing. Re-using the same `id` updates an existing skill.
 *
 * Factory pattern mirrors `buildInvokeSkillTool` — captures dbPath/registry
 * so the handler can open a short-lived SkillStore and validate tool names.
 */
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ResolvedSkill, SkillContextMode } from '@mcp/code-agent/skills/types.js';
import { SkillStore, type UpsertSkillInput } from '@mcp/store/skill-store.js';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { validateSkillInput } from './create-skill-validation.js';
import { evalSkillTriggers } from '@mcp/code-agent/tools/skill-trigger-eval.js';
import { assertMutationFence } from '@mcp/code-agent/core/mutation-fence.js';

const SKILL_ID_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const CONTEXT_MODES: SkillContextMode[] = ['auto', 'tool', 'both'];

export interface CreateSkillDeps {
  dbPath: string;
  registry: ToolRegistry;
  /** Current project — used when scope === 'project'. */
  projectId: number;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

export function buildCreateSkillTool(deps: CreateSkillDeps): CoderTool {
  return {
    name: 'create_skill',
    effectBoundary: 'control',
    source: 'native',
    mutates: true,
    parallelSafe: false,
    riskLevel: 'write',
    description:
      'Author a NEW skill or update an existing one (reuse its id to update). A skill is a reusable prompt package that the agent loads on demand. ' +
      'ALWAYS call with `dry_run: true` first: it validates the id + allowed_tools and runs a trigger eval (does the skill fire on its declared triggers? what collides?) WITHOUT saving. ' +
      'Fix the report, then call again without dry_run to persist. ' +
      'Triggers are how a skill auto-loads: trigger_roles / trigger_tags / trigger_paths (globs). A skill with no triggers is discovery-only — make its `description` discriminating so the agent finds it via get_skills_list. ' +
      'Set `slash_command` to expose it as /<command> in the chat composer.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'kebab-case id, 1-64 chars [a-z0-9-]. Reusing an existing id updates that skill.' },
        name: { type: 'string', description: 'Human-readable name.' },
        description: { type: 'string', description: 'One line. This drives discovery — make it specific and include trigger phrases (PT+EN if relevant).' },
        prompt_body: { type: 'string', description: 'The skill instructions (markdown). Template vars like $USER_INPUT, $PROJECT_ROOT are interpolated at load time.' },
        slash_command: { type: 'string', description: 'Optional. Exposes the skill as /<command> in the composer. Lowercase, no spaces.' },
        context_mode: { type: 'string', enum: CONTEXT_MODES, description: 'auto = inject when triggers match; tool = invocable via invoke_skill; both. Default auto.' },
        trigger_paths: { type: 'array', items: { type: 'string' }, description: 'Glob patterns; auto-loads when recent files match (e.g. "**/*.test.ts").' },
        trigger_roles: { type: 'array', items: { type: 'string' }, description: 'Subordinate roles that auto-load this skill (e.g. ["extractor"]).' },
        trigger_tags: { type: 'array', items: { type: 'string' }, description: 'Session tags that auto-load this skill (e.g. ["qa"]).' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Optional. Restrict the skill to this tool subset. Names are validated against the registry.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags for filtering.' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'global (all projects, default) or project (current project only).' },
        sort_order: { type: 'number', description: 'Ordering hint (lower = earlier). Default 0.' },
        version: { type: 'string', description: 'Semver. Default 1.0.0.' },
        dry_run: { type: 'boolean', description: 'Validate + eval triggers without saving. Do this first.' },
      },
      required: ['id', 'name', 'description', 'prompt_body'],
      additionalProperties: false,
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      ctx.signal?.throwIfAborted();
      try { validateSkillInput(args); } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
      const id = String(args.id ?? '').trim();
      const name = String(args.name ?? '').trim();
      const description = String(args.description ?? '').trim();
      const promptBody = String(args.prompt_body ?? '');
      if (!id || !name || !promptBody.trim()) {
        return err('create_skill: `id`, `name` and `prompt_body` are required and must be non-empty.');
      }
      if (!SKILL_ID_RE.test(id)) {
        return err(`create_skill: invalid id "${id}" — must be 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen.`);
      }
      const contextMode = (CONTEXT_MODES.includes(args.context_mode as SkillContextMode)
        ? args.context_mode
        : 'auto') as SkillContextMode;
      const slashCommand = typeof args.slash_command === 'string' && args.slash_command.trim()
        ? args.slash_command.trim().replace(/^\//, '').toLowerCase()
        : null;
      const triggerPaths = strArray(args.trigger_paths) ?? null;
      const triggerRoles = strArray(args.trigger_roles) ?? null;
      const triggerTags = strArray(args.trigger_tags) ?? null;
      const allowedTools = strArray(args.allowed_tools) ?? null;
      const baseTags = strArray(args.tags) ?? [];
      const dryRun = args.dry_run === true;

      const warnings: string[] = [];
      if (!description) warnings.push('description is empty — the agent relies on it to discover the skill. Add a specific one-liner.');

      let store: SkillStore | undefined;
      let dispatched = false;
      try {
        // No synchronous SQLite busy wait may stall cancellation in this worker.
        store = new SkillStore(deps.dbPath, { busyTimeoutMs: 0 });
        // Validate allowed_tools against the live registry (catches typos).
        if (allowedTools) {
          const known = new Set(deps.registry.list().map((t) => t.name));
          const unknown = allowedTools.filter((t) => !known.has(t));
          if (unknown.length) warnings.push(`unknown tool name(s) in allowed_tools: ${unknown.join(', ')} — they will silently match nothing.`);
        }

        // Slash command collision (a different skill already owns it).
        if (slashCommand) {
          const owner = store.getSkillBySlashCommand(slashCommand);
          if (owner && owner.id !== id) warnings.push(`slash command /${slashCommand} is already used by skill "${owner.id}".`);
        }

        const existing = store.getSkill(id);
        if (existing && existing.scope !== 'global' && existing.scope !== String(deps.projectId)) return err('create_skill: this ID belongs to another project. Choose a different ID.');
        if (args.scope === 'project' && (!Number.isSafeInteger(deps.projectId) || deps.projectId <= 0)) return err('create_skill: project scope requires a current project.');
        const isUpdate = !!existing;

        // Trigger eval against the current enabled catalog.
        const catalog = store.listSkillTriggerCatalog(deps.projectId);
        const candidate: ResolvedSkill = {
          id, name, description, slashCommand,
          promptBody, allowedTools,
          modelOverride: null, providerOverride: null,
          contextMode, pathPatterns: null,
          triggerPaths, triggerRoles, triggerTags,
          tags: baseTags, source: 'user', author: null,
          sortOrder: typeof args.sort_order === 'number' ? args.sort_order : 0,
        };
        const triggerReport = evalSkillTriggers(candidate, catalog.items);
        if (catalog.partial) warnings.push(`Trigger collisions checked in a bounded sample (${catalog.items.length}/${catalog.totalCount} skills); some definitions or metadata were omitted.`);
        await yieldToEvents(); ctx.signal?.throwIfAborted();

        const header = `${dryRun ? '[dry run] ' : ''}${isUpdate ? 'Update' : 'Create'} skill "${id}"${slashCommand ? ` (/${slashCommand})` : ''}`;
        const reportText = [
          header,
          '',
          'Trigger eval:',
          ...triggerReport.summary.map((s) => `  ${s}`),
          ...(warnings.length ? ['', 'Warnings:', ...warnings.map((w) => `  ⚠ ${w}`)] : []),
        ].join('\n');

        if (dryRun) {
          return ok(`${reportText}\n\nValidation passed. Call again without dry_run to persist.`);
        }

        const scope = args.scope === 'project' ? String(deps.projectId) : args.scope === 'global' ? 'global' : existing?.scope ?? 'global';
        const tags = [...new Set([...baseTags, ...(triggerTags ?? []).map((t) => `trigger:${t}`)])];
        const upsert: UpsertSkillInput = {
          id, name, description,
          slash_command: slashCommand,
          prompt_body: promptBody,
          scope, enabled: true,
          allowed_tools: allowedTools,
          context_mode: contextMode,
          tags,
          sort_order: candidate.sortOrder,
          trigger_paths: triggerPaths,
          trigger_roles: triggerRoles,
          author: null,
          version: typeof args.version === 'string' && args.version.trim() ? args.version.trim() : '1.0.0',
          source: 'user',
        };
        const beforeWrite = () => {
          ctx.signal?.throwIfAborted();
          assertMutationFence(ctx.mutationFence, { kind: 'control', operation: 'create_skill.upsert', resource: id });
        };
        beforeWrite(); dispatched = true;
        store.upsertAuthoredSkill(upsert, deps.projectId, beforeWrite);

        return ok(`${reportText}\n\n✓ ${isUpdate ? 'Updated' : 'Created'} and saved (scope=${scope === 'global' ? 'global' : 'project'}). ${slashCommand ? `Available as /${slashCommand}. ` : ''}The next attempt will load the updated skill catalog.`);
      } catch (e) {
        if (dispatched) return unknownToolOutcome(`create_skill did not confirm its commit: ${e instanceof Error ? e.message : String(e)}. Read the existing skill before retrying.`);
        return err(`create_skill failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        store?.close();
      }
    },
  };
}
