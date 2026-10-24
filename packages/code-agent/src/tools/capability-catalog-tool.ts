import { createHash } from 'node:crypto';
import type { AgentRunId, CapabilityId } from '@mcp/agent-runtime-contracts';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { structuredResult } from '@mcp/code-agent/core/model-output.js';
import {
  deriveCapabilityDescriptor,
  resolveCapabilitySet,
  skillAsCatalogCapability,
} from '@mcp/code-agent/core/capability-catalog.js';
import type { ResolvedSkill, SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import { interpolateSkillVars } from '@mcp/code-agent/skills/prompt-injector.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { SessionId } from '@mcp/session-storage';
import {
  getToolText,
  passesRelaxed,
  passesStrict,
  scoreTool,
  tokenizeQuery,
} from './find-tools-score.js';

const MAX_RESULTS = 10;
const MAX_ACTIVATIONS = 8;
const MAX_SKILL_BODY_CHARS = 40_000;
const MAX_DESCRIBE_DESCRIPTOR_BYTES = 8 * 1_024;
const MAX_DESCRIBE_RESPONSE_BYTES = 64 * 1_024;

function catalogResult(data: unknown): ToolResult {
  return structuredResult(data, '', { env: { MCP_TOOL_RESULT_MARKDOWN: '0' } });
}

export interface CapabilityCatalogToolDeps {
  registry: ToolRegistry;
  skills: readonly ResolvedSkill[];
  skillTemplateContext: SkillTemplateContext;
  sessionStore?: FsSessionStore;
  sessionId?: SessionId;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedLimit(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(parsed)))
    : fallback;
}

function boundedDescriptor(
  descriptor: ReturnType<typeof deriveCapabilityDescriptor>['descriptor'],
): ReturnType<typeof deriveCapabilityDescriptor>['descriptor'] | Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(descriptor), 'utf8') <= MAX_DESCRIBE_DESCRIPTOR_BYTES) {
    return descriptor;
  }
  return {
    ...descriptor,
    inputSchema: {
      type: 'object',
      $comment: 'Schema omitted from this bounded response; request the executable capability by id.',
      'x-schema-sha256': digest(descriptor.inputSchema),
    },
    schemaTruncated: true,
  };
}

function boundedDescribeResponse(items: readonly unknown[]): Record<string, unknown> {
  const response = { items };
  const encoded = JSON.stringify(response, null, 2);
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_DESCRIBE_RESPONSE_BYTES) return response;
  return {
    items: items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const record = item as Record<string, unknown>;
      const { descriptor: _descriptor, ...summary } = record;
      return { ...summary, descriptorOmitted: true };
    }),
    truncated: true,
    reason: 'describe_response_budget',
  };
}

/**
 * Canonical, bounded discovery surface for native/ToolHost/MCP/plugin/skill
 * capabilities. Legacy discovery tools remain compatibility aliases during
 * migration, but new callers need only this contract.
 */
export function buildCapabilityCatalogTool(deps: CapabilityCatalogToolDeps): CoderTool {
  const buildEntries = () => ({
    toolEntries: deps.registry.list().filter(tool => tool.name !== 'capability_catalog')
      .map(tool => ({ tool, descriptor: deriveCapabilityDescriptor(tool).descriptor })),
    skillEntries: deps.skills.map(source => {
      const skill = structuredClone(source);
      const virtual = skillAsCatalogCapability(skill);
      return { skill, virtual, descriptor: deriveCapabilityDescriptor(virtual).descriptor,
        searchText: getToolText({ name: skill.id, description: `${skill.name} ${skill.description} ${skill.tags.join(' ')}` }) };
    }),
  });
  let sealedEntries: ReturnType<typeof buildEntries> | undefined;
  return {
    name: 'capability_catalog',
    description:
      'Search, list, describe, or activate capabilities from the immutable attempt snapshot. ' +
      'Covers native tools, indexer/ToolHost, MCP, plugins, and skills. Search/list return bounded ' +
      'summaries; describe hydrates selected contracts; activate reveals only already-authorized entries.',
    source: 'native',
    mutates: false,
    parallelSafe: false,
    executionClass: 'control',
    effectBoundary: 'control',
    riskLevel: 'read',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['search', 'list', 'describe', 'activate'] },
        query: { type: 'string' },
        namespace: { type: 'string' },
        capability_ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_ACTIVATIONS },
        cursor: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: MAX_RESULTS },
        input: { type: 'string', description: 'Optional interpolation input when activating a skill.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      ctx.signal?.throwIfAborted();
      const native = ctx.ports?.discovery;
      native?.assertCurrent();
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > MAX_RESULTS)) return err('capability_catalog limit must be an integer from 1 to 10.');
      if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(args.cursor))) return err('capability_catalog cursor is invalid.');
      for (const field of ['query', 'namespace', 'input']) {
        if (args[field] !== undefined && (typeof args[field] !== 'string' || (args[field] as string).length > 4_000)) return err(`capability_catalog ${field} must be a string of at most 4000 characters.`);
      }
      const entries = deps.registry.isSealed ? (sealedEntries ??= buildEntries()) : buildEntries();
      const toolEntries = native ? entries.toolEntries.filter(e => native.eligibleCapabilityIds.has(e.descriptor.capabilityId)
        && native.visibleToolNames.has(e.tool.name)) : entries.toolEntries;
      const skillEntries = native ? entries.skillEntries.filter(e => native.eligibleCapabilityIds.has(e.descriptor.capabilityId)) : entries.skillEntries;
      const op = String(args.op ?? '');
      const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';
      const namespaceMatches = (entry: { descriptor: ReturnType<typeof deriveCapabilityDescriptor>['descriptor'] }): boolean => {
        if (!namespace) return true;
        const source = entry.descriptor.source;
        return source.kind === namespace
          || source.providerId === namespace
          || source.serverId === namespace;
      };
      const summary = (entry: { descriptor: ReturnType<typeof deriveCapabilityDescriptor>['descriptor'] }) => ({
        capabilityId: entry.descriptor.capabilityId,
        name: entry.descriptor.name,
        displayName: entry.descriptor.displayName,
        summary: entry.descriptor.description.slice(0, 280),
        source: entry.descriptor.source.kind,
        namespace: entry.descriptor.source.serverId ?? entry.descriptor.source.providerId,
        tier: entry.descriptor.visibility.defaultTier,
      });

      if (op === 'list') {
        const limit = boundedLimit(args.limit, 10);
        const cursor = Math.max(0, Number.parseInt(String(args.cursor ?? '0'), 10) || 0);
        const entries = [
          ...toolEntries.filter(namespaceMatches),
          ...skillEntries.filter(namespaceMatches),
        ].sort((a, b) => a.descriptor.capabilityId.localeCompare(b.descriptor.capabilityId));
        const page = entries.slice(cursor, cursor + limit).map(summary);
        return catalogResult({
          items: page,
          nextCursor: cursor + page.length < entries.length ? String(cursor + page.length) : null,
          total: entries.length,
        });
      }

      if (op === 'search') {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return err('capability_catalog search requires `query`.');
        const tokens = tokenizeQuery(query);
        if (tokens.length === 0) return err('capability_catalog query has no usable tokens.');
        const candidates = [
          ...toolEntries.filter(namespaceMatches).map((entry) => ({
            ...entry,
            score: scoreTool(tokens, getToolText(entry.tool)),
          })),
          ...skillEntries.filter(namespaceMatches).map((entry) => ({
            ...entry,
            score: scoreTool(tokens, entry.searchText),
          })),
        ];
        const strict = candidates.filter((entry) => passesStrict(entry.score, tokens.length, 0.5));
        const weak = strict.length === 0;
        const selected = (weak
          ? candidates.filter((entry) => passesRelaxed(entry.score, tokens.length, 0.5))
          : strict)
          .sort((a, b) => b.score.total - a.score.total
            || a.descriptor.capabilityId.localeCompare(b.descriptor.capabilityId))
          .slice(0, boundedLimit(args.limit, 5));
        return catalogResult({
          query,
          weak,
          items: selected.map(summary),
        });
      }

      if (args.capability_ids !== undefined && (!Array.isArray(args.capability_ids)
        || args.capability_ids.some(id => typeof id !== 'string' || id.length > 256))) return err('capability_ids must contain bounded string identifiers.');
      const requested = Array.isArray(args.capability_ids)
        ? args.capability_ids.filter((value): value is string => typeof value === 'string')
        : [];
      if (requested.length === 0) return err(`capability_catalog ${op} requires capability_ids.`);
      if (requested.length > MAX_ACTIVATIONS) {
        return err(`capability_catalog accepts at most ${MAX_ACTIVATIONS} capability_ids.`);
      }
      const toolById = new Map(toolEntries.map((entry) => [entry.descriptor.capabilityId, entry]));
      const skillById = new Map(skillEntries.map((entry) => [entry.descriptor.capabilityId, entry]));

      if (op === 'describe') {
        const items = requested.map((id) => {
          const toolEntry = toolById.get(id as CapabilityId);
          if (toolEntry) return {
            ...summary(toolEntry),
            descriptor: boundedDescriptor(toolEntry.descriptor),
          };
          const skillEntry = skillById.get(id as CapabilityId);
          if (skillEntry) {
            return {
              ...summary(skillEntry),
              descriptor: boundedDescriptor(skillEntry.descriptor),
              instructionBundleRef: skillEntry.descriptor.source.provenanceRef,
              requiredCapabilities: skillEntry.skill.allowedTools ?? [],
            };
          }
          return { capabilityId: id, error: 'not_in_attempt_snapshot' };
        });
        return catalogResult(boundedDescribeResponse(items));
      }

      if (op !== 'activate') return err(`Unsupported capability_catalog op '${op}'.`);
      const runner = ctx.runner as {
        promoteTool?: (name: string) => string[];
        runId?: string;
      } | undefined;
      const activated: unknown[] = [];
      const rejected: unknown[] = [];
      for (const id of requested) {
        ctx.signal?.throwIfAborted(); native?.assertCurrent();
        const toolEntry = toolById.get(id as CapabilityId);
        if (toolEntry) {
          if (native) {
            activated.push({ capabilityId: id, effective: 'already_visible', evicted: [] });
            continue;
          }
          if (!runner?.promoteTool) {
            rejected.push({ capabilityId: id, reason: 'runner_activation_unavailable' });
            continue;
          }
          const evicted = runner.promoteTool(toolEntry.tool.name);
          activated.push({ capabilityId: id, effective: 'next_turn', evicted });
          continue;
        }
        const skillEntry = skillById.get(id as CapabilityId);
        if (!skillEntry) {
          rejected.push({ capabilityId: id, reason: 'not_in_attempt_snapshot' });
          continue;
        }
        const missingRequirements = (skillEntry.skill.allowedTools ?? [])
          .filter((name: string) => !deps.registry.has(name) || (native && !native.visibleToolNames.has(name)));
        if (missingRequirements.length > 0) {
          rejected.push({ capabilityId: id, reason: 'required_capability_missing', missingRequirements });
          continue;
        }
        const body = interpolateSkillVars(skillEntry.skill.promptBody, {
          ...deps.skillTemplateContext,
          USER_INPUT: typeof args.input === 'string' ? args.input : '',
          TIMESTAMP: new Date().toISOString(),
        });
        if (body.length > MAX_SKILL_BODY_CHARS) {
          rejected.push({ capabilityId: id, reason: 'instruction_exceeds_catalog_budget', suggestedTool: 'get_skill_content' });
          continue;
        }
        if (!native && deps.sessionStore && deps.sessionId) {
          try {
            await deps.sessionStore.recordSessionInput({
              session_id: deps.sessionId,
              kind: 'skill_content',
              source_label: `capability_catalog:${skillEntry.skill.id}`,
              content: body,
              meta: { capability_id: id, source: skillEntry.skill.source },
            });
          } catch { /* diagnostics cannot block activation */ }
        }
        activated.push({ capabilityId: id, effective: 'immediate_instruction', instruction: body });
      }
      const agentRunId = (runner?.runId ?? '00000000-0000-4000-8000-000000000000') as AgentRunId;
      const capabilitySetHash = native?.capabilitySetDigest ?? resolveCapabilitySet(
        [...deps.registry.list(), ...deps.skills.map(skillAsCatalogCapability)], { agentRunId }).set.hash;
      return catalogResult({
        capabilitySetDigest: capabilitySetHash,
        projectionDigest: null,
        projectionState: native ? 'immutable_attempt_snapshot' : 'recomputed_at_next_turn_boundary',
        activationDigest: digest({ capabilitySet: capabilitySetHash, activated, rejected }),
        activated,
        rejected,
      });
    },
  };
}
