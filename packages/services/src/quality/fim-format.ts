/**
 * Multi-file context rendering for FIM prompts, per model family ("flavor"):
 *   qwen      — repo-level FIM tokens (<|repo_name|> / <|file_sep|>) the
 *               qwen-coder family was trained on (Continue-proven).
 *   codestral — `+++++ {path}` file blocks (Mistral's documented format);
 *               `\n+++++ ` doubles as a runaway stop.
 *   comment   — `// Path: x` commented blocks (Tabby/Copilot style), safe on
 *               every other FIM model (DeepSeek et al.).
 * The VOLATILE block (scope + receiver members) is always rendered as line
 * comments immediately before the prefix — nearest the cursor in every flavor.
 */

export type FimFlavor = 'qwen' | 'codestral' | 'comment';

export interface FimSnippet {
  filePath: string;
  content: string;
}

export function fimFlavor(modelId: string): FimFlavor {
  if (/qwen[\d.]*-?coder|coder.*qwen/i.test(modelId)) return 'qwen';
  if (/codestral|devstral/i.test(modelId)) return 'codestral';
  return 'comment';
}

/**
 * Snippet bodies must never smuggle FIM control tokens (editing THIS engine
 * inside the IDE would otherwise break its own completions) — strip sentinel
 * runs instead of escaping (hint context, fidelity is secondary).
 */
export function sanitizeFimText(s: string): string {
  return s
    .replace(/<\|[a-z_]+\|>/gi, '')
    .replace(/<\[fim-[a-z]+\]>/gi, '')
    .replace(/^\+{5,}\s*/gm, '');
}

function commentizeWith(block: string, comment: string): string {
  return block.split('\n').map((l) => (l ? comment + l : comment.trimEnd())).join('\n');
}

export interface RenderFimContextOpts {
  repoName: string;
  currentFile: string;
  /** Line-comment prefix for the language (from fim-templates.lineCommentPrefix). */
  commentPrefix: string;
  /** Scope + receiver members — rendered comment-style right before the prefix. */
  volatileBlock?: string;
}

export function renderFimContext(
  flavor: FimFlavor,
  snippets: FimSnippet[],
  opts: RenderFimContextOpts,
): { contextText: string; extraStop: string[] } {
  const clean = snippets
    .map((s) => ({ filePath: s.filePath, content: sanitizeFimText(s.content).trim() }))
    .filter((s) => s.content.length > 0);
  const volatile = opts.volatileBlock?.trim()
    ? commentizeWith(sanitizeFimText(opts.volatileBlock), opts.commentPrefix)
    : '';

  if (flavor === 'qwen' && clean.length > 0) {
    const files = clean.map((s) => `<|file_sep|>${s.filePath}\n${s.content}`).join('\n');
    const text = `<|repo_name|>${opts.repoName}\n${files}\n<|file_sep|>${opts.currentFile}\n${volatile ? `${volatile}\n` : ''}`;
    return { contextText: text, extraStop: ['<|file_sep|>'] };
  }

  if (flavor === 'codestral' && clean.length > 0) {
    const files = clean.map((s) => `+++++ ${s.filePath}\n${s.content}`).join('\n\n');
    const text = `${files}\n\n+++++ ${opts.currentFile}\n${volatile ? `${volatile}\n` : ''}`;
    return { contextText: text, extraStop: ['\n+++++ '] };
  }

  // comment flavor (or no snippets — volatile alone still renders)
  const files = clean
    .map((s) => `${opts.commentPrefix}Path: ${s.filePath}\n${commentizeWith(s.content, opts.commentPrefix)}`)
    .join('\n\n');
  const parts = [files, volatile].filter(Boolean);
  return { contextText: parts.length > 0 ? `${parts.join('\n\n')}\n` : '', extraStop: [] };
}
