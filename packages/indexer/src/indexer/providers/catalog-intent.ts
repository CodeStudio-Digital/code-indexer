import type { ProviderModel } from '@mcp/store/provider-store.js';
import { matchCatalogProviders, providerAtStart, type CatalogProviderIdentity } from '@mcp/shared/providers/catalog-match.js';

export interface CatalogRequirements { input_modalities?: string[]; min_context?: number; effort?: string }
export interface CatalogIntentRequest { query: string; provider?: string; requires?: CatalogRequirements; offset: number; limit: number }
export type CatalogFacts = Pick<ProviderModel, 'input_modalities' | 'context_window' | 'supported_reasoning_levels'>;

export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const modality = (s: string) => s.toLowerCase() === 'speech' ? 'audio' : s.toLowerCase();
export function readRequirements(input: unknown): CatalogRequirements {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid model requirements');
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(k => !['input_modalities','min_context','effort'].includes(k))) throw new Error('Unknown model requirement');
  const r: CatalogRequirements = {};
  if (v.input_modalities !== undefined) {
    if (!Array.isArray(v.input_modalities) || !v.input_modalities.length || v.input_modalities.length > 12 ||
      !v.input_modalities.every((s: unknown) => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(s))) throw new Error('Invalid input_modalities');
    r.input_modalities = [...new Set(v.input_modalities.map(modality))];
  }
  if (v.min_context !== undefined) {
    if (!Number.isSafeInteger(v.min_context) || Number(v.min_context) < 1) throw new Error('Invalid min_context');
    r.min_context = Number(v.min_context);
  }
  if (v.effort !== undefined) {
    if (typeof v.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(v.effort)) throw new Error('Invalid effort');
    r.effort = v.effort.toLowerCase();
  }
  return r;
}

export function meetsRequirements(model: CatalogFacts, required: CatalogRequirements): boolean {
  return (!required.min_context || (model.context_window ?? 0) >= required.min_context) &&
    (!required.effort || !!model.supported_reasoning_levels?.includes(required.effort)) &&
    (!required.input_modalities?.length || (Array.isArray(model.input_modalities) &&
      required.input_modalities.every(m => model.input_modalities!.some(actual => typeof actual === 'string' && modality(actual) === m))));
}

/** Infer only input constraints, not output formats ("generate an image"). Explicit tool parameters also work in any language. */
export function intentFacts(query: string, explicit: CatalogRequirements = {}) {
  const q = fold(query);
  const modalities = new Set(explicit.input_modalities ?? []);
  const consumes = /\b(analis\w*|analy[sz]\w*|aceit\w*|accept\w*|entend\w*|understand\w*|ler|leia|read\w*|receb\w*|input|entrada|inspect\w*|interpret\w*|extrai\w*|extract\w*|descrev\w*|describ\w*|transcrev\w*|transcri\w*|ouvir|listen\w*|transformar|tirar|identif\w*|locate)\b/;
  if (consumes.test(q)) {
    const inputs: ReadonlyArray<[string, RegExp]> = [
      ['image', /\b(imagem|imagens|prints?|screenshots?|capturas? de tela|images?|pictures?|fotos?|photos?)\b/g],
      ['audio', /\b(audio|fala gravada|gravac(?:ao|oes)|recordings?|speech|voice)\b/g],
      ['video', /\bvideos?\b/g],
    ];
    const inferred = inputs.filter(([,pattern]) => [...q.matchAll(pattern)].some(m =>
      !/\b(?:sem|without|except|exceto|into|output(?:\s+as)?|gerar|generate|(?:texto|text)\s+(?:em|to))\s+(?:uma?\s+|an?\s+)?$/.test(q.slice(0,m.index))));
    if (!(inferred.length > 1 && /\b(ou|or)\b/.test(q))) {
      for (const [type] of inferred) modalities.add(type);
    }
  }
  const numeric = /\b(\d+(?:[.,]\d+)?)\s*(milhoes|milhao|million|mil|[km])?\s*(?:de\s+)?tokens?\b/.exec(q);
  const isMinimum = numeric && !/\b(no maximo|at most|up to|ate|output|saida)\b/.test(q) &&
    /\b(contexto?|janela|context|window|minim[ou]m?|at least|pelo menos)\b/.test(q);
  const minimum = isMinimum ? Number(numeric[1].replace(',', '.')) *
    (['mil','k'].includes(numeric[2]) ? 1000 : ['m','milhao','milhoes','million'].includes(numeric[2]) ? 1_000_000 : 1) : 0;
  const min_context = Math.max(explicit.min_context ?? 0, minimum);
  const effort = explicit.effort ?? /\b(?:effort|esforco)\s*(?:de\s+)?(minimal|low|medium|high|xhigh|max|none)\b/.exec(q)?.[1];
  const requires: CatalogRequirements = { ...(modalities.size ? {input_modalities: [...modalities]} : {}),
    ...(min_context ? {min_context} : {}), ...(effort ? {effort} : {}) };
  return { requires, longContext: /\b(?:long[ -]context|(?:contexto|janela)(?: de contexto)? (?:longo|longa|ampl[oa]|grande))\b/.test(q) };
}

/** Missing versions and selectable IDs stay exact. An explicit intent search can contain numbers or punctuation. */
export function looksLikeModelName(query: string): boolean {
  const words = query.trim().split(/\s+/);
  return !/\p{L}/u.test(query) || (words.length === 1 && /[\d/:._-]/.test(query)) ||
    (words.length <= 5 && /\b\d+(?:[.-]\d+)+\b/.test(query)) ||
    (words.length <= 4 && /\s+v?\d+$/.test(query));
}

const common = new Set(('a o as os um uma que de em com para pelo pela no na por do da e ou ' +
  'quero preciso consiga capaz modelo modelos usar use um me encontrar procure qual ' +
  'a an at in on or and with of to for the is that can i need want model models find').split(' '));
export const intentWords = (s: string) => [...new Set((fold(s).match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length > 1 && !common.has(t)))];

/** Direct natural-language lookups honor a named account just like structured tool arguments. */
export function catalogSelection(query: string, provider: string | undefined, requires: CatalogRequirements | undefined,
  identities: () => CatalogProviderIdentity[]) {
  const original = query;
  const markers = /\b(?:via|pelo|pela|na|no|do|da|on|from|using|with)\s+(?:(?:the|o|a)\s+)?(?:(?:provider|provedor)\s+)?|\b(?:provider|provedor)\s*[:=]?\s+/gi;
  let accounts: CatalogProviderIdentity[] | undefined, conflict = false;
  for (const m of [...query.matchAll(markers)].reverse()) {
    const tail = query.slice(m.index + m[0].length);
    accounts ??= identities().map(p => ({ ...p, enabled: true }));
    const ref = providerAtStart(tail, accounts);
    if (!ref) {
      if (/\b(?:provider|provedor)\b/i.test(m[0])) conflict = true;
      continue;
    }
    const { name, rest } = ref;
    if (provider) {
      const prior = matchCatalogProviders(accounts, provider);
      const found = matchCatalogProviders(accounts, name);
      const overlap = prior.filter(p => found.some(f => f.id === p.id));
      if (!overlap.length) conflict = true;
      else if (overlap.length === 1) provider = overlap[0].id;
    } else provider = name;
    query = (query.slice(0,m.index) + ' ' + rest).trimEnd();
  }
  const level = /\s+(?:no|em|at|with|com|effort|esforço)\s+(?:(?:effort|esforço)\s+)?(máximo|maximo|maximum|max|xhigh|high|medium|low|minimal)\s*(?:effort)?[.!]?\s*$/i.exec(query);
  if (level) {
    const effort = /^(?:máximo|maximo|maximum)$/i.test(level[1]) ? 'max' : level[1].toLowerCase();
    if (requires?.effort && requires.effort !== effort) conflict = true;
    requires = {...requires, effort};
    query = query.slice(0,level.index);
  }
  if (query !== original) query = query.trim().replace(/^(?:usa|use)\s+(?:(?:o|a|the)\s+)?/i,'').replace(/^modelo?\s+/i,'');
  query = query.trim();
  return { query, provider, requires, conflict };
}
