/**
 * Raw FIM prompt templates for OpenAI-compatible `/completions` hosts that do
 * NOT understand the `suffix` body param (most self-hosted vLLM/Ollama-style
 * gateways silently drop it, ruining the completion). Each code-model family
 * trains its own sentinel tokens — sending the wrong ones yields garbage, so
 * selection is by model id (Continue.dev's AutocompleteTemplate pattern).
 *
 * Native FIM endpoints (DeepSeek `/beta/completions`, Mistral
 * `/fim/completions`) take `prompt`+`suffix` directly → `resolveFimTemplate`
 * returns null for those kinds and the caller keeps the native body shape.
 */
import type { ResolvedBinding } from '../pipelines/index.js';

export interface FimTemplate {
  id: 'qwen' | 'starcoder' | 'codellama' | 'codegemma' | 'granite' | 'seedcoder' | 'codestral-raw';
  assemble(p: { prefix: string; suffix: string }): string;
  /** Model-family stop tokens (≤3 each — leaves room for the caller's '\n'). */
  stop: string[];
}

const TEMPLATES: Record<FimTemplate['id'], FimTemplate> = {
  qwen: {
    id: 'qwen',
    assemble: ({ prefix, suffix }) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
    stop: ['<|endoftext|>', '<|fim_prefix|>', '<|repo_name|>'],
  },
  starcoder: {
    id: 'starcoder',
    assemble: ({ prefix, suffix }) => `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
    stop: ['<|endoftext|>', '<file_sep>', '<fim_prefix>'],
  },
  // CodeLlama's spaces around the sentinels are part of the trained format.
  codellama: {
    id: 'codellama',
    assemble: ({ prefix, suffix }) => `<PRE> ${prefix} <SUF>${suffix} <MID>`,
    stop: [' <EOT>', '<EOT>'],
  },
  codegemma: {
    id: 'codegemma',
    assemble: ({ prefix, suffix }) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
    stop: ['<|file_separator|>', '<|fim_prefix|>', '<end_of_turn>'],
  },
  granite: {
    id: 'granite',
    assemble: ({ prefix, suffix }) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
    stop: ['<|endoftext|>'],
  },
  seedcoder: {
    id: 'seedcoder',
    assemble: ({ prefix, suffix }) => `<[fim-prefix]>${prefix}<[fim-suffix]>${suffix}<[fim-middle]>`,
    stop: ['<[fim-prefix]>', '<[fim-suffix]>'],
  },
  // Codestral on a NON-mistral host (self-hosted): SPM order, suffix first.
  'codestral-raw': {
    id: 'codestral-raw',
    assemble: ({ prefix, suffix }) => `[SUFFIX]${suffix}[PREFIX]${prefix}`,
    stop: ['[PREFIX]', '[SUFFIX]'],
  },
};

/** First-match model-id → template family. Order matters (qwen before coder-generic). */
const MODEL_TEMPLATE_TABLE: Array<[RegExp, FimTemplate['id']]> = [
  [/qwen[\d.]*-?coder|coder.*qwen/i, 'qwen'],
  [/starcoder|stable-?code/i, 'starcoder'],
  [/codellama|code-llama/i, 'codellama'],
  [/codegemma/i, 'codegemma'],
  [/granite/i, 'granite'],
  [/seed-?coder/i, 'seedcoder'],
  [/codestral/i, 'codestral-raw'],
];

/**
 * Pick the raw template for a binding, or null to use the native
 * `prompt`+`suffix` body. Precedence: explicit `fim_template` config
 * ('native' forces null; a template id forces that template) → native-endpoint
 * kinds (deepseek/mistral) → model-id table → null.
 */
export function resolveFimTemplate(binding: ResolvedBinding): FimTemplate | null {
  const cfg = binding.config as Record<string, unknown>;
  const requested = typeof cfg.fim_template === 'string' ? cfg.fim_template.trim() : '';
  if (requested === 'native') return null;
  if (requested && requested !== 'auto') {
    return TEMPLATES[requested as FimTemplate['id']] ?? null;
  }
  const kind = binding.provider.kind;
  if (kind === 'deepseek' || kind === 'mistral') return null; // native FIM endpoints
  for (const [re, id] of MODEL_TEMPLATE_TABLE) {
    if (re.test(binding.modelId)) return TEMPLATES[id];
  }
  return null;
}

/**
 * Merge stop sequences under the OpenAI-compat 4-entry limit. Caller stops
 * come FIRST — the single-line '\n' must survive template stops (which are
 * runaway guards, not correctness guards).
 */
export function mergeStops(caller: string[] | undefined, template: string[]): string[] {
  const out: string[] = [];
  for (const s of [...(caller ?? []), ...template]) {
    if (!out.includes(s)) out.push(s);
    if (out.length === 4) break;
  }
  return out;
}

/** Language → line-comment prefix for commentized context blocks. */
export function lineCommentPrefix(language: string): string {
  if (/^(python|ruby|shell|bash|sh|yaml|r|perl|toml|dockerfile|makefile|elixir)$/i.test(language)) return '# ';
  if (/^(sql|lua|haskell|ada)$/i.test(language)) return '-- ';
  return '// ';
}

/** Render a context block as line comments (FIM prompts have no system role). */
export function commentize(block: string, language: string): string {
  const c = lineCommentPrefix(language);
  return block.split('\n').map((l) => (l ? c + l : c.trimEnd())).join('\n');
}
