import { resolveReasoningEffort } from '@mcp/provider-sdk';
import { catalogTerms, matchCatalogProviders, providerAtStart } from '@mcp/shared/providers/catalog-match.js';
import type { ProviderModel, ProviderStore } from '@mcp/store/provider-store.js';
import type { ChildChatPort } from '../ports/child-chat-port.js';

type Catalog = Pick<ProviderStore, 'listProviderIdentities' | 'listModels'>;
type Selection = { provider: string; model: string; effort?: string };
type RequestedTarget = { provider: string; model?: string; effort?: string };
const discover = 'Use tools.mcp__list_models({provider, query}) in code_exec to search within the requested provider. Keep its configured ID on retry.';
const modelId = (m: ProviderModel) => m.mode ? `${m.model_id}::${m.mode}` : m.model_id;

function providerId(catalog: Catalog, name: string): string {
  const matches = matchCatalogProviders(catalog.listProviderIdentities(), name);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`Ambiguous provider "${name}". Configured IDs: ${matches.map(p => p.id).join(', ')}. ${discover}`);
  throw new Error(`Provider "${name}" is unknown or disabled. Search enabled accounts with tools.mcp__list_models(${JSON.stringify({ view: 'providers', query: name })}) in code_exec.`);
}

// Only drop the GPT family label and rearrange name/version words. Every version
// component must match. Never choose the closest version or another provider.
function modelKey(name: string): string {
  return catalogTerms(name).filter(word => word !== 'gpt').sort().join(' ');
}

function resolveSelection(catalog: Catalog, selection: Selection): Selection {
  const provider = providerId(catalog, selection.provider);
  const models = catalog.listModels(provider);
  const exact = models.find(row => modelId(row) === selection.model);
  const key = modelKey(selection.model);
  const matches = exact ? [exact].filter(row => row.enabled) : models.filter(row => row.enabled && key &&
    (modelKey(modelId(row)) === key || modelKey(row.name) === key || (row.display_name && modelKey(row.display_name) === key)));
  if (matches.length !== 1) {
    const candidates = matches.length ? ' Matching IDs: ' + matches.map(modelId).join(', ') + '.' : '';
    throw new Error(`Model "${selection.model}" is ${matches.length ? 'ambiguous' : 'unknown or disabled'} for "${provider}".${candidates} ` +
      `Query tools.mcp__list_models(${JSON.stringify({ provider, query: selection.model })}) in code_exec.`);
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

function declaredEffort(rest: string): string | undefined {
  const level = /^[\s,;/]*(?:(?:no|na|em|com|at|on|with|effort|esforço|de)\s*[:=]?\s*)*(minimal|low|medium|high|xhigh|xhigth|max|none)\b/i.exec(rest)?.[1]?.toLowerCase();
  if (level === 'xhigth') return 'xhigh';
  return level ?? (/^[\s,;/]*(?:(?:no|na|em|at|com|effort|esforço)\s+)*(?:máximo|maximo|maximum)\b/i.test(rest) ? 'max' : undefined);
}

function declaredTarget(provider: string, tail: string): Selection | undefined {
  const quoted = /^["'`]([^"'`]+)["'`]/.exec(tail);
  const model = (quoted?.[1] ?? tail.split(/[,;!?]|\.(?=\s|$)|\s+\/\s+|\s+(?:no|na|em|com|para|pra|do|at|on|with|for|effort|esforço)\b/i, 1)[0])
    ?.trim().replace(/\.$/, '');
  if (!model || /^(?:(?:um|uma|a|an|o|the)\s+)?(?:modelo?\s+)?(?:que|which|that|capaz|capable|para|for|effort|esforço|contexto|context window)\b/i.test(model)) return;
  const rest = tail.slice(quoted?.[0].length ?? model.length);
  const effort = declaredEffort(rest);
  return { provider: provider.trim().replace(/^[`"']|[`"']$/g, ''), model, ...(effort ? { effort } : {}) };
}

/** Read declarations from the human instruction, excluding fenced code, Markdown blockquotes and IDE context. */
function userSelections(message: string, catalog: Catalog): RequestedTarget[] {
  const prose = message.replace(/<ide_context>[\s\S]*?<\/ide_context>|\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)/gi, '')
    .replace(/^[ \t]*>[^\n]*/gm, '').replace(/\*\*/g, '');
  const selections: RequestedTarget[] = [], providersOnly: RequestedTarget[] = [];
  const delegation = /\b(?:agents?|agentes?|chats?|subagents?|subagentes?|deleg\w*|filh[oa]s?|revisor(?:es)?|reviewers?|create_chat|pedi|asked for)\b/i;
  const delegating = delegation.test(prose);
  // Resolve names against this profile only when a clause actually introduces a provider.
  let identities: ReturnType<Catalog['listProviderIdentities']> | undefined;
  for (const clause of prose.split(/[;!?\r\n]+|\.(?=\s|$)/)) {
    const imperative = /\b(?:usa|use|using)\s+/i.test(clause);
    if (!delegating && !imperative) continue;
    const fields = /\b(?:provider|provedor)\b\s*[:=]?\s*([^,;]+?)\s*[,/ ]+\s*modelo?\b\s*[:=]?\s*(.+)/i.exec(clause);
    if (fields) {
      const target = declaredTarget(fields[1], fields[2]);
      if (target) selections.push(target);
      continue;
    }
    for (const marker of clause.matchAll(/\b(?:pedi(?:\s+foi)?|asked for|com|via|pelo|pela|no|na|do|da|from|with|on|using|usando|usa|use)\s+(?:(?:o|a|the)\s+)?(?:(?:provider|provedor)\s+)?/gi)) {
      const before = clause.slice(0, marker.index);
      if (/(?:não|nao|nunca|not|never)\s*$/i.test(before)) continue;
      const tail = clause.slice(marker.index + marker[0].length);
      identities ??= catalog.listProviderIdentities().map(p => ({ ...p, enabled: true }));
      const reference = providerAtStart(tail, identities);
      if (!reference) continue;
      const { name, rest } = reference;
      if (/^(?:do|da|from)\b/i.test(marker[0])) {
        const reverse = /\b(?:modelo?\s+|(?:com|usa|use|using)\s+(?:(?:o|the)\s+)?(?:modelo?\s+)?)([^,;]{1,96})$/i.exec(before.trimEnd());
        if (reverse && (delegation.test(clause) || imperative)) {
          const target = declaredTarget(name, reverse[1] + rest);
          if (target) selections.push(target);
          else if (delegating) providersOnly.push({ provider: name, effort: declaredEffort(rest) });
        } else if (delegation.test(clause) || imperative) {
          providersOnly.push({ provider: name, effort: declaredEffort(rest) });
        }
        continue;
      }
      const model = /^[\s,/]+(?:(?:com|with)\s+(?:(?:(?:o|the)\s+)?modelo?\s+)?|modelo?\s*[:=]?\s+)(.+)/i.exec(rest);
      const target = model && declaredTarget(name, model[1]);
      if (target) selections.push(target);
      else if (delegation.test(clause) || imperative) providersOnly.push({ provider: name, effort: declaredEffort(rest) });
    }
  }
  return selections.length ? selections : providersOnly;
}

/** Each worker run owns its retry state. A fresh user instruction is a new selection. */
export function routeChildChats(port: ChildChatPort, catalog: Catalog, parent: { provider: string; model: string },
  latestUserText: () => Promise<string>): ChildChatPort & { catalogSelection(): Promise<{ provider: string; query?: string } | undefined> } {
  let instruction: string | undefined;
  let requested: RequestedTarget[] = [];
  let rejected: { provider?: string; model?: string; effort?: string } | undefined;
  async function refreshInstruction() {
    const message = await latestUserText();
    if (message !== instruction) {
      requested = userSelections(message, catalog);
      instruction = message;
      rejected = undefined;
    }
    return { message, targets: requested };
  }
  return { ...port, async catalogSelection() {
    const { targets } = await refreshInstruction();
    if (targets.length === 1) return { provider: targets[0].provider, query: targets[0].model };
  }, async create(caller, request) {
    const { message, targets } = await refreshInstruction();
    const pins = targets.map(target => target.model
      ? resolveSelection(catalog, { ...target, model: target.model })
      : { ...target, provider: providerId(catalog, target.provider) });
    const pinHint = pins.map(pin => JSON.stringify(pin)).join(' or ');
    if (pins.length && !request.model) throw new Error(`The user selected ${pinHint}. Retry create_chat with that target. No child started.`);
    if (rejected && ((rejected.model && !request.model) || (rejected.provider && !request.provider && pins.length !== 1) || (rejected.effort && !request.effort && !pins.length))) {
      throw new Error(`The requested child target failed. Retry with the requested target${pinHint ? ': ' + pinHint : ''}. ${discover} No child started.`);
    }
    let selection: Partial<Selection> = {};
    try {
      if (request.model || request.provider) {
        if (pins.length && request.provider) {
          const candidate = providerId(catalog, request.provider);
          if (!pins.some(p => p.provider === candidate)) throw new Error(`Provider "${candidate}" conflicts with the requested provider. ${discover}`);
        }
        selection = resolveSelection(catalog, { provider: request.provider || (pins.length === 1 ? pins[0].provider : parent.provider),
          model: request.model || parent.model, effort: request.effort });
        if (pins.length) {
          const pin = pins.find(p => p.provider === selection.provider && (!p.model || p.model === selection.model) &&
            (!p.effort || !selection.effort || p.effort === selection.effort));
          if (!pin) throw new Error('The tool arguments conflict with the user selection.');
          if (pin.effort && !selection.effort) selection = resolveSelection(catalog, { provider: pin.provider, model: selection.model!, effort: pin.effort });
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
