/**
 * Member-aware completion for the structural-index fallback (no LSP server).
 *
 * Detects a `Cls::` / `self::` / `$this->` member-access trigger from the
 * buffer and lists that class's members from the index — the PHPStorm-feeling
 * "type the arrow, see the methods" without a language server. Honest limits
 * (name-based, no semantics): NO inherited members (no extends/implements
 * walk), NO typed-variable resolution (`$user->` where `$user` isn't `$this`
 * stays unresolved), NO traits. Those need a real LSP — the chip stays blue.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CompletionItem } from '@mcp/api-bus';
import type { DBSymbol } from '@mcp/shared/types.js';

export interface MemberTrigger {
  access: 'static' | 'instance' | null;
  /** Token left of the operator: a class name, `self`/`static`/`parent`, or `$this`/`$var`. */
  receiver: string;
  /** Member-name prefix already typed after the operator (may be empty). */
  prefix: string;
}

const MEMBER_RE = /[A-Za-z0-9_]/;       // member names (no leading $)
const CLASS_RE = /[A-Za-z0-9_\\]/;      // class token incl. FQN backslashes
const RECEIVER_RE = /[A-Za-z0-9_$]/;    // instance receiver incl. $this/$var

/** Kinds that can follow `new`/`extends`/etc. — a type, not a function/var. */
export const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'trait', 'struct', 'type']);

/**
 * True when the text immediately before the prefix is a type-position
 * keyword (`new Foo`, `extends Foo`, `implements Foo`, `instanceof Foo`,
 * `catch (Foo`, `use Foo`). In those spots an IDE lists only TYPES — not
 * functions/variables. Language-agnostic enough for PHP/TS/JS/Java/C#.
 */
export function isTypePosition(lineBeforePrefix: string): boolean {
  return /(?:^|[\s(|&,])(?:new|extends|implements|instanceof|use)\s+$/.test(lineBeforePrefix)
    || /\bcatch\s*\(\s*$/.test(lineBeforePrefix);
}

/** Namespace/package-style location for the IntelliJ-style right column. */
export function describeLocation(filePath: string, languageId?: string): string {
  const slash = filePath.lastIndexOf('/');
  const dir = slash < 0 ? '' : filePath.slice(0, slash);
  if (!dir) return '';
  // PHP reads namespaces with backslashes; everything else keeps the path.
  return languageId === 'php' ? dir.replace(/\//g, '\\') : dir;
}

function trailingRun(text: string, re: RegExp): string {
  let i = text.length;
  while (i > 0 && re.test(text[i - 1]!)) i--;
  return text.slice(i);
}

/** Inspect the text left of the 1-based `column` for a member-access trigger. */
export function detectMemberTrigger(lineText: string, column: number): MemberTrigger {
  const idx = Math.max(0, Math.min(column - 1, lineText.length));
  let p = idx;
  while (p > 0 && MEMBER_RE.test(lineText[p - 1]!)) p--;
  const prefix = lineText.slice(p, idx);
  const before = lineText.slice(0, p);
  if (before.endsWith('::')) {
    return { access: 'static', receiver: trailingRun(before.slice(0, -2), CLASS_RE), prefix };
  }
  if (before.endsWith('->')) {
    return { access: 'instance', receiver: trailingRun(before.slice(0, -2), RECEIVER_RE), prefix };
  }
  return { access: null, receiver: '', prefix };
}

/** The class/interface/trait/enum whose [line,end_line] brackets `line`. */
export function enclosingClass(symbols: DBSymbol[], line: number): string | null {
  const containers = symbols.filter(
    (s) => s.kind === 'class' || s.kind === 'interface' || s.kind === 'enum',
  );
  let best: DBSymbol | null = null;
  for (const s of containers) {
    const start = s.line ?? 0;
    if (start > line) continue;
    const end = s.end_line ?? Number.MAX_SAFE_INTEGER;
    if (line > end) continue;
    // Prefer the innermost (highest start line) container that brackets it.
    if (!best || start > (best.line ?? 0)) best = s;
  }
  return best?.name ?? null;
}

function parseModifiers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Build a completion item from an index symbol. Callables (method/function)
 * insert as a snippet with the cursor between the parens — `name($1)` /
 * `name()$0` — PHPStorm-style. Scoped to method/function so a `$`-prefixed
 * property name never lands in a snippet string.
 */
export function buildSymbolCompletion(
  s: DBSymbol, tier: number, opts: { showPath?: boolean; languageId?: string } = {},
): CompletionItem {
  const callable = s.kind === 'method' || s.kind === 'function';
  const hasParams = !!s.parameters && s.parameters.replace(/[()\s]/g, '').length > 0;
  return {
    label: s.name,
    kind: s.kind,
    detail: s.signature || s.kind,
    insertText: callable ? (hasParams ? `${s.name}($1)` : `${s.name}()$0`) : s.name,
    insertTextFormat: callable ? 2 : 1,
    // Zero-padded tier prefix → Monaco's lexical sortText preserves the
    // relevance order (current file → imported → same dir → rest).
    sortText: String(tier).padStart(2, '0') + s.name,
    // IntelliJ-style right column: the symbol's namespace/dir (dimmed).
    labelDetails: opts.showPath ? { description: describeLocation(s.file_path, opts.languageId) } : undefined,
  };
}

/** Members of `className` (optionally static-only), prefix-filtered. */
export function memberCompletions(
  db: CodeIndexDB, projectId: number, className: string,
  opts: { staticOnly: boolean; prefix: string },
): CompletionItem[] {
  const members = db.getClassMembers(className, projectId);
  const out: CompletionItem[] = [];
  for (const m of members) {
    if (opts.prefix && !m.name.startsWith(opts.prefix)) continue;
    if (opts.staticOnly && !parseModifiers(m.modifiers).includes('static')) continue;
    out.push(buildSymbolCompletion(m, 0));
  }
  return out.slice(0, 100);
}
