import { resolveReasoningEffort } from '@mcp/provider-sdk';
import type { ProviderModel, ProviderStore } from '@mcp/store/provider-store.js';
import type { ChildChatPort } from '../ports/child-chat-port.js';

type Catalog = Pick<ProviderStore, 'listProviderIdentities' | 'listModels'>;
type Selection = { provider: string; model: string; effort?: string };
const discover = 'Look up the requested target with tools.mcp__list_models in code_exec. Keep the requested provider and model when retrying create_chat.';
const label = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const modelId = (m: ProviderModel) => m.mode ? `${m.model_id}::${m.mode}` : m.model_id;

function providerId(catalog: Catalog, name: string): string {
  const rows = catalog.listProviderIdentities();
  const exact = rows.find(p => p.id === name);
  if (exact?.enabled) return exact.id;
  if (!exact) {
    const key = label(name);
    const kind = ['codex', 'chatgpt codex', 'codex chatgpt'].includes(key) ? 'chatgpt' : key;
    const byName = rows.filter(p => p.enabled && (label(p.id) === key || label(p.name) === key));
    const matches = byName.length ? byName : rows.filter(p => p.enabled && label(p.kind) === kind);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) throw new Error(`Ambiguous provider "${name}". Configured IDs: ${matches.map(p => p.id).join(', ')}. ${discover}`);
  }
  throw new Error(`Provider "${name}" is unknown or disabled. ${discover}`);
}

// Only drop the GPT family label and rearrange name/version words. Every version
// component must match. Never choose the closest version or another provider.
function modelKey(name: string): string {
  return (name.toLowerCase().match(/[\p{L}]+|\d+(?:\.\d+)*/gu) ?? []).filter(word => word !== 'gpt').sort().join(' ');
}

function resolveSelection(catalog: Catalog, selection: Selection): Selection {
  const provider = providerId(catalog, selection.provider);
  const models = catalog.listModels(provider);
  const exact = models.find(row => modelId(row) === selection.model);
  const key = modelKey(selection.model);
  const matches = exact ? [exact].filter(row => row.enabled) : models.filter(row => row.enabled && key &&
    (modelKey(modelId(row)) === key || modelKey(row.name) === key || (row.display_name && modelKey(row.display_name) === key)));
  if (matches.length !== 1) {
    const available = (matches.length ? matches : models.filter(m => m.enabled)).slice(0, 12).map(modelId);
    throw new Error(`Model "${selection.model}" is ${matches.length ? 'ambiguous' : 'unknown or disabled'} for "${provider}". ` +
      `Configured IDs: ${available.join(', ') || '(none)'}. Query tools.mcp__list_models({provider:${JSON.stringify(provider)}}) in code_exec.`);
  }
  const row = matches[0];
  const selected = { provider, model: modelId(row) };
  if (!selection.effort) return selected;
  const { effort } = resolveReasoningEffort({ requestedEffort: selection.effort,
    capability: { canReason: row.can_reason, supportedLevels: row.supported_reasoning_levels } });
  if (!effort) throw new Error(`Effort "${selection.effort}" is unavailable for ${provider}/${selected.model}. Supported: ${row.supported_reasoning_levels?.join(', ') || '(none advertised)'}.`);
  return { ...selected, effort };
}

/** At the host boundary the model has already been selected, including profile inheritance. */
export function validateChildChatTarget(catalog: Catalog, provider: string, model: string, effort?: string): void {
  const selected = resolveSelection(catalog, { provider, model, effort });
  if (provider !== selected.provider || model !== selected.model) {
    throw new Error(`Use the configured target ${JSON.stringify(selected)}. ${discover}`);
  }
}

function declaredTarget(provider: string, tail: string): Selection | undefined {
  const quoted = /^["'`]([^"'`]+)["'`]/.exec(tail);
  const model = (quoted?.[1] ?? tail.split(/[,;!?]|\.(?=\s|$)|\s+\/\s+|\s+(?:no|na|em|com|para|pra|do|at|on|with|for|effort|esforço)\b/i, 1)[0])
    ?.trim().replace(/\.$/, '');
  if (!model) return;
  const rest = tail.slice(quoted?.[0].length ?? model.length);
  const effort = /^[\s,;/]*(?:(?:no|na|em|com|at|on|with|effort|esforço|de)\s*[:=]?\s*)*(minimal|low|medium|high|xhigh|xhigth|max|none)\b/i.exec(rest)?.[1]?.toLowerCase();
  return { provider: provider.trim().replace(/^[`"']|[`"']$/g, ''), model, ...(effort ? { effort: effort === 'xhigth' ? 'xhigh' : effort } : {}) };
}

/** Read declarations from the human instruction, excluding fenced code, Markdown blockquotes and IDE context. */
function userSelections(message: string): Selection[] {
  const prose = message.replace(/<ide_context>[\s\S]*?<\/ide_context>|\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)/gi, '')
    .replace(/^[ \t]*>[^\n]*/gm, '');
  const selections: Selection[] = [];
  const delegating = /\b(?:agents?|agentes?|chats?|subagents?|subagentes?|deleg\w*|filh[oa]s?|create_chat)\b|\b(?:usa|use|using)\s+(?:(?:o|the)\s+)?(?:provider|provedor)\b/i.test(prose);
  for (const clause of prose.split(/[;\r\n]+/)) {
    const fields = delegating && /\b(?:provider|provedor)\b\s*[:=]?\s*([^,;]+?)\s*[,/ ]+\s*(?:modelo|model)\b\s*[:=]?\s*(.+)/i.exec(clause);
    const match = fields || /\b(?:usa|use|using)\s+(?:(?:o|the)\s+)?(chatgpt(?:\s*[- /]\s*codex)?|codex)\s+(?:(?:com|with)\s+(?:(?:(?:o|the)\s+)?modelo?\s+)?|modelo?\s+)(.+)/i.exec(clause);
    const target = match && declaredTarget(match[1], match[2]);
    if (target) selections.push(target);
  }
  return selections;
}

/** Each worker run owns its retry state. A fresh user instruction is a new selection. */
export function routeChildChats(port: ChildChatPort, catalog: Catalog, parent: { provider: string; model: string },
  latestUserText: () => Promise<string>): ChildChatPort {
  let instruction: string | undefined;
  let requested: Selection[] = [];
  let rejected: { provider?: string; model?: string; effort?: string } | undefined;
  return { ...port, async create(caller, request) {
    const message = await latestUserText();
    if (message !== instruction) {
      instruction = message;
      requested = userSelections(message);
      rejected = undefined;
    }
    const pins = requested.map(target => resolveSelection(catalog, target));
    const pinHint = pins.map(pin => JSON.stringify(pin)).join(' or ');
    if (pins.length && !request.model) throw new Error(`The user selected ${pinHint}. Retry create_chat with that target. No child started.`);
    if (rejected && ((rejected.model && !request.model) || (rejected.provider && !request.provider && pins.length !== 1) || (rejected.effort && !request.effort && !pins.length))) {
      throw new Error(`The requested child target failed. Retry with the requested target${pinHint ? ': ' + pinHint : ''}. ${discover} No child started.`);
    }
    let selection: Partial<Selection> = {};
    try {
      if (request.model || request.provider) {
        selection = resolveSelection(catalog, { provider: request.provider || (pins.length === 1 ? pins[0].provider : parent.provider),
          model: request.model || parent.model, effort: request.effort });
        if (pins.length) {
          const pin = pins.find(p => p.provider === selection.provider && p.model === selection.model &&
            (!p.effort || !selection.effort || p.effort === selection.effort));
          if (!pin) throw new Error('The tool arguments conflict with the user selection.');
          if (pin.effort) selection.effort = pin.effort;
        }
      }
    } catch (error) {
      rejected = { provider: request.provider, model: request.model, effort: request.effort };
      throw new Error(`${error instanceof Error ? error.message : error}${pinHint ? ' User selected ' + pinHint + '.' : ''} No child started.`);
    }
    const previous = rejected;
    try {
      const result = await port.create(caller, { ...request, ...selection });
      if (instruction === message && rejected === previous) rejected = undefined;
      return result;
    } catch (error) {
      if (instruction === message && (request.provider || request.model || request.effort)) {
        rejected = { provider: request.provider, model: request.model, effort: request.effort };
      }
      throw error;
    }
  } };
}
