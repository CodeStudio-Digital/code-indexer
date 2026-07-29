/**
 * A miniature Monarch driver for grammar tests.
 *
 * Monaco's real `MonarchTokenizer` needs the whole standalone services
 * container (language service + theme service + configuration service), which a
 * unit test can't spin up. This replays the same loop over the COMPILED lexer —
 * first matching rule wins, `@push`/`@pop` maintain the state stack, group
 * actions map onto capture groups — so a test can assert the token a fragment
 * actually receives, states and all, instead of eyeballing rule arrays.
 */
// eslint-disable-next-line import/no-unresolved
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js';

type Action = string | { token?: string; next?: string; group?: Action[]; test?: TestFn };
type TestFn = (id: string, matches: string[], state: string, eos: boolean) => Action;
interface CompiledRule { resolveRegex(state: string): RegExp; action: Action }
interface CompiledLexer {
  tokenizer: Record<string, CompiledRule[]>;
  start: string;
  tokenPostfix: string;
  defaultToken: string;
}

export interface Token { text: string; token: string }

/** Resolve `cases` actions down to a concrete token/next pair. */
function resolve(action: Action, m: RegExpExecArray, state: string): Action {
  return typeof action === 'object' && typeof action.test === 'function'
    ? resolve(action.test(m[0], m as unknown as string[], state, false), m, state)
    : action;
}

const tokenOf = (action: Action): string =>
  typeof action === 'string' ? action : action.token ?? '';

const nextOf = (action: Action): string | undefined =>
  typeof action === 'string' ? undefined : action.next;

/**
 * Tokenize one line. `start` overrides the entry state — PHP needs `phpRoot`,
 * since the grammar's own entry point is the HTML host state.
 */
export function tokenizeLine(
  language: unknown,
  line: string,
  opts: { languageId?: string; start?: string } = {},
): Token[] {
  const lexer = compile(opts.languageId ?? 'test', language as never) as unknown as CompiledLexer;
  const postfix = (token: string): string => (token === '' ? '' : token + (lexer.tokenPostfix ?? ''));
  const stack = [opts.start ?? lexer.start];
  const out: Token[] = [];

  for (let pos = 0, guard = 0; pos < line.length && guard < 1000; guard += 1) {
    const state = stack[stack.length - 1];
    const rest = line.slice(pos);
    let hit: { m: RegExpExecArray; action: Action } | null = null;
    for (const rule of lexer.tokenizer[state] ?? []) {
      const m = rule.resolveRegex(state).exec(rest);
      if (m) { hit = { m, action: resolve(rule.action, m, state) }; break; }
    }
    if (!hit) { out.push({ text: rest[0], token: postfix(lexer.defaultToken) }); pos += 1; continue; }

    const { m, action } = hit;
    const groups = typeof action === 'object' ? action.group : undefined;
    if (groups) {
      groups.forEach((g, i) => {
        const part = resolve(g, m, state);
        if (m[i + 1]) out.push({ text: m[i + 1], token: postfix(tokenOf(part).replace('$0', m[0])) });
      });
    } else {
      out.push({ text: m[0], token: postfix(tokenOf(action).replace('$0', m[0])) });
    }

    const next = groups ? groups.map((g) => nextOf(resolve(g, m, state))).filter(Boolean).pop() : nextOf(action);
    if (next === '@pop') stack.pop();
    else if (next === '@push') stack.push(state);
    else if (next) stack.push(next);

    pos += Math.max(m[0].length, next ? 0 : 1);
  }
  return out;
}

/** The token assigned to the first occurrence of `text` (trimmed compare). */
export function tokenFor(tokens: Token[], text: string): string | undefined {
  return tokens.find((t) => t.text.trim() === text)?.token;
}
