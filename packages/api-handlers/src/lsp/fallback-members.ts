/**
 * Member-aware completion for the structural-index fallback (no LSP server).
 *
 * Detects a `Cls::` / `self::` / `$this->` member-access trigger from the
 * buffer and lists that class's members from the index — the PHPStorm-feeling
 * "type the arrow, see the methods" without a language server. Inherited and
 * trait members come from the relations walk (db.getClassMembersDeep —
 * extends/implements/mixes, cycle-guarded) annotated with their origin class.
 * Honest limit that remains (name-based, no semantics): NO typed-variable
 * resolution (`$user->` where `$user` isn't `$this` stays unresolved). That
 * needs a real LSP — the chip stays blue.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CompletionItem, Position } from '@mcp/api-bus';
import type { DBSymbol } from '@mcp/shared/types.js';
import { dirname, posix } from 'node:path';

export interface MemberTrigger {
  access: 'static' | 'instance' | null;
  /** Token left of the operator: a class name, `self`/`static`/`parent`, or `$this`/`$var`. */
  receiver: string;
  /** Member-name prefix already typed after the operator (may be empty). */
  prefix: string;
}

export interface PhpImportPlan {
  additionalTextEdits?: CompletionItem['additionalTextEdits'];
  insertText?: string;
}

interface CompletionEditPlan {
  additionalTextEdits?: CompletionItem['additionalTextEdits'];
  insertText?: string;
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
    || /\b(?:catch|as|satisfies)\s*(?:\(\s*)?$/.test(lineBeforePrefix)
    || /(?:\)|[A-Za-z_$][A-Za-z0-9_$]*|\$[A-Za-z_][A-Za-z0-9_]*)\??\s*:\s*$/.test(lineBeforePrefix);
}

/** Namespace/package-style location for the IntelliJ-style right column. */
export function describeLocation(
  filePath: string, languageId?: string, namespace?: string | null,
): string {
  // Mig 187: when the index carries the REAL namespace (PHP `App\Services`,
  // Python dotted module), show it instead of the transformed dir path.
  if (namespace) return namespace;
  const slash = filePath.lastIndexOf('/');
  const dir = slash < 0 ? '' : filePath.slice(0, slash);
  if (!dir) return '';
  // PHP reads namespaces with backslashes; everything else keeps the path.
  return languageId === 'php' ? dir.replace(/\//g, '\\') : dir;
}

function phpNamespace(content: string): string | null {
  const match = /^\s*namespace\s+([^;{]+)\s*[;{]/m.exec(content);
  if (!match) return null;
  return match[1]!.trim().replace(/^\\+/, '').replace(/\\+$/, '') || null;
}

function phpShortName(fqn: string): string {
  return fqn.replace(/^\\+/, '').split('\\').pop() || fqn;
}

function phpImportedTypes(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^\s*use\s+([^;]+);/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const raw = match[1]!.trim();
    if (/^(function|const)\s+/i.test(raw)) continue;
    if (raw.includes('{') || raw.includes('}')) continue;
    const asMatch = /\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(raw);
    const fqn = raw.replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*$/i, '').replace(/^\\+/, '').trim();
    const alias = asMatch?.[1] ?? phpShortName(fqn);
    if (alias && fqn) out.set(alias, fqn);
  }
  return out;
}

function phpUseInsertPosition(content: string): Position {
  const lines = content.split('\n');
  let insertAfter = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\b/.test(line)) break;
    if (/^\s*<\?php\b/.test(line)) insertAfter = Math.max(insertAfter, i + 1);
    else if (/^\s*declare\s*\(/.test(line)) insertAfter = Math.max(insertAfter, i + 1);
    else if (/^\s*namespace\s+[^;{]+;/.test(line)) insertAfter = Math.max(insertAfter, i + 1);
    else if (/^\s*use\s+(?!function\b|const\b)[^;]+;/.test(line)) insertAfter = Math.max(insertAfter, i + 1);
  }
  return { line: insertAfter + 1, column: 1 };
}

/** Shared core: plan a `use` insertion given the target's namespace. */
function phpImportPlan(currentContent: string, targetNs: string | null, symbolName: string): PhpImportPlan {
  if (!targetNs) return {};

  const targetFqn = `${targetNs}\\${symbolName}`;
  if (phpNamespace(currentContent) === targetNs) return {};

  const imported = phpImportedTypes(currentContent);
  // `use X\Y;` OR `use X\Y as Z;` — the target FQN imported under ANY alias
  // counts as already-imported (no duplicate use, no FQN fallback).
  for (const fqn of imported.values()) if (fqn === targetFqn) return {};
  // Short name already taken by a DIFFERENT FQN → insert fully qualified.
  if (imported.has(symbolName)) return { insertText: `\\${targetFqn}` };

  const position = phpUseInsertPosition(currentContent);
  return {
    additionalTextEdits: [{
      range: { start: position, end: position },
      newText: `use ${targetFqn};\n`,
    }],
  };
}

export function phpImportPlanForCompletion(
  currentContent: string,
  targetContent: string,
  symbolName: string,
): PhpImportPlan {
  return phpImportPlan(currentContent, phpNamespace(targetContent), symbolName);
}

/**
 * DB-backed plan (mig 187): the target namespace comes straight from the
 * indexed symbol — zero disk I/O per keystroke, and usable for ANY exported
 * class completion, not just typesOnly positions.
 */
export function phpImportPlanForSymbol(currentContent: string, s: DBSymbol): PhpImportPlan {
  if (!s.exported) return {};
  const ns = (s.namespace ?? '').replace(/^\\+/, '').replace(/\\+$/, '');
  return phpImportPlan(currentContent, ns || null, s.name);
}

function importInsertPosition(content: string): Position {
  const lines = content.split('\n');
  let insertAfter = 0;
  if (lines[0]?.startsWith('#!')) insertAfter = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*import\b/.test(line)) insertAfter = Math.max(insertAfter, i + 1);
    else if (insertAfter > 0 && line.trim() && !/^\s*\/\//.test(line)) break;
  }
  return { line: insertAfter + 1, column: 1 };
}

function tsModuleSpecifier(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile.replace(/\\/g, '/'));
  let spec = posix.relative(fromDir === '.' ? '' : fromDir, toFile.replace(/\\/g, '/'));
  spec = spec.replace(/\.(?:tsx?|jsx?|mts|cts)$/i, '');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}

export function tsImportPlanForCompletion(
  currentContent: string,
  currentFile: string,
  s: DBSymbol,
): CompletionEditPlan {
  if (s.file_path === currentFile || !s.exported) return {};
  const spec = tsModuleSpecifier(currentFile, s.file_path);
  const alreadyImported = new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s\\S]{0,120}\\bfrom\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(currentContent);
  if (alreadyImported) return {};
  const typeOnly = s.kind === 'interface' || s.kind === 'type';
  const position = importInsertPosition(currentContent);
  return {
    additionalTextEdits: [{
      range: { start: position, end: position },
      newText: `import ${typeOnly ? 'type ' : ''}{ ${s.name} } from '${spec}';\n`,
    }],
  };
}

export function inferPhpVariableClass(content: string, receiver: string, line: number): string | null {
  if (!receiver.startsWith('$')) return null;
  const name = receiver.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = content.split('\n').slice(0, Math.max(0, line - 1)).join('\n');

  const phpDoc = new RegExp(`@var\\s+\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)\\s+\\$${name}\\b`, 'g');
  const fromNew = new RegExp(`\\$${name}\\s*=\\s*new\\s+\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)\\b`, 'g');
  const fromStatic = new RegExp(`\\$${name}\\s*=\\s*\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)::([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g');

  const candidates: Array<{ index: number; className: string; method?: string }> = [];
  const collect = (re: RegExp, methodIndex?: number): void => {
    let match: RegExpExecArray | null;
    while ((match = re.exec(before))) {
      candidates.push({ index: match.index, className: match[1]!, method: methodIndex ? match[methodIndex] : undefined });
    }
  };
  collect(phpDoc);
  collect(fromNew);
  collect(fromStatic, 2);

  const best = candidates.sort((a, b) => b.index - a.index)[0];
  if (!best) return null;
  const short = best.className.split('\\').pop() || best.className;
  const method = best.method;
  const eloquentBuilderMethods = new Set([
    'query', 'with', 'where', 'whereIn', 'whereNot', 'orderBy', 'select', 'join',
    'leftJoin', 'rightJoin', 'latest', 'oldest',
  ]);
  if (method && (eloquentBuilderMethods.has(method) || /Model$/.test(short))) return 'Builder';
  return short;
}

function trailingRun(text: string, re: RegExp): string {
  let i = text.length;
  while (i > 0 && re.test(text[i - 1]!)) i--;
  return text.slice(i);
}

function inlineNewReceiver(text: string): string | null {
  const trimmedEnd = text.trimEnd();
  if (!trimmedEnd.endsWith(')')) return null;
  let depth = 0;
  let open = -1;
  for (let i = trimmedEnd.length - 1; i >= 0; i--) {
    const ch = trimmedEnd[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) {
        open = i;
        break;
      }
    }
  }
  if (open < 0) return null;
  const beforeArgs = trimmedEnd.slice(0, open).trimEnd();
  const match = /(?:^|[^\w\\$])new\s+\\?([A-Za-z_][A-Za-z0-9_\\]*)$/.exec(beforeArgs);
  return match?.[1] ?? null;
}

/**
 * Inspect the text left of the 1-based `column` for a member-access trigger.
 * `opts.dot` opts into the `.` operator (dot-languages: TS/JS/Python/…) — OFF
 * by default so PHP/Ruby (`.` = string concat) and the suggest-widget fallback
 * keep their `::`/`->`-only behavior.
 */
export function detectMemberTrigger(
  lineText: string, column: number, opts?: { dot?: boolean },
): MemberTrigger {
  const idx = Math.max(0, Math.min(column - 1, lineText.length));
  let p = idx;
  while (p > 0 && MEMBER_RE.test(lineText[p - 1]!)) p--;
  const prefix = lineText.slice(p, idx);
  const before = lineText.slice(0, p);
  if (before.endsWith('::')) {
    return { access: 'static', receiver: trailingRun(before.slice(0, -2), CLASS_RE), prefix };
  }
  if (before.endsWith('->')) {
    const receiverText = before.slice(0, -2);
    const receiver = trailingRun(receiverText, RECEIVER_RE);
    return { access: 'instance', receiver: receiver || inlineNewReceiver(receiverText) || '', prefix };
  }
  // Single `.` member access (not `..` ranges / float literals like `3.`).
  if (opts?.dot && before.endsWith('.') && !before.endsWith('..')) {
    const receiver = trailingRun(before.slice(0, -1), RECEIVER_RE);
    if (receiver && !/^\d+$/.test(receiver)) {
      return { access: 'instance', receiver, prefix };
    }
  }
  return { access: null, receiver: '', prefix };
}

/** Receivers that resolve to the class the cursor sits in (not a named type). */
const SELF_RECEIVERS = new Set(['self', 'static', 'parent', '$this']);

/**
 * Resolve a member-access receiver to a class name usable with
 * `getClassMembers`. `self`/`static`/`parent`/`$this` resolve to the enclosing
 * class; a static `Cls::`/FQN receiver resolves to its short name; an unknown
 * instance receiver (a typed `$var->`) stays unresolved — that needs a real
 * LSP. Extracted so the index fallback and the autocomplete context builder
 * share ONE resolution rule.
 */
export function resolveReceiverClass(
  trigger: MemberTrigger, fileSymbols: DBSymbol[], line: number,
): string | null {
  if (!trigger.access) return null;
  if (SELF_RECEIVERS.has(trigger.receiver)) return enclosingClass(fileSymbols, line);
  if (trigger.access === 'static') return trigger.receiver.split('\\').pop() || null;
  if (trigger.access === 'instance' && trigger.receiver && !trigger.receiver.startsWith('$')) {
    return trigger.receiver.split('\\').pop() || null;
  }
  return null; // typed instance receiver ($var->) — index can't resolve
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
  s: DBSymbol, tier: number,
  opts: { showPath?: boolean; languageId?: string; editPlan?: CompletionEditPlan; origin?: string } = {},
): CompletionItem {
  const callable = s.kind === 'method' || s.kind === 'function';
  const hasParams = !!s.parameters && s.parameters.replace(/[()\s]/g, '').length > 0;
  // IntelliJ-style label columns: params logo após o nome (labelDetails.detail) e, à
  // direita (labelDetails.description, dimmed), o namespace/dir (quando showPath) OU o
  // tipo de retorno — membros herdados anexam a origem (`from Base`). Assim itens do
  // índice mostram a assinatura mesmo sem LSP server.
  const ns = opts.showPath ? describeLocation(s.file_path, opts.languageId, s.namespace) : '';
  const originTag = opts.origin ? `from ${opts.origin}` : '';
  const description = ns || [s.return_type, originTag].filter(Boolean).join(' · ');
  const paramsCol = callable && hasParams ? s.parameters! : '';
  const labelDetails = paramsCol || description
    ? { ...(paramsCol ? { detail: paramsCol } : {}), ...(description ? { description } : {}) }
    : undefined;
  return {
    label: s.name,
    kind: s.kind,
    detail: s.signature || s.kind,
    insertText: opts.editPlan?.insertText
      ?? (callable ? (hasParams ? `${s.name}($1)` : `${s.name}()$0`) : s.name),
    insertTextFormat: callable ? 2 : 1,
    // Zero-padded tier prefix → Monaco's lexical sortText preserves the
    // relevance order (current file → imported → same dir → rest).
    sortText: String(tier).padStart(2, '0') + s.name,
    labelDetails,
    additionalTextEdits: opts.editPlan?.additionalTextEdits,
  };
}

/**
 * Members of `className` INCLUDING inherited/trait members (relations walk —
 * extends/implements/mixes), optionally static-only, prefix-filtered.
 * Inherited members sort after own members (tier 1 vs 0) and carry a
 * `from Ancestor` origin tag in labelDetails.description.
 */
export function memberCompletions(
  db: CodeIndexDB, projectId: number, className: string,
  opts: { staticOnly: boolean; prefix: string },
): CompletionItem[] {
  const { members } = db.getClassMembersDeep(projectId, className);
  const out: CompletionItem[] = [];
  for (const m of members) {
    if (opts.prefix && !m.name.startsWith(opts.prefix)) continue;
    if (opts.staticOnly && !parseModifiers(m.modifiers).includes('static')) continue;
    out.push(buildSymbolCompletion(m, m.inherited_from ? 1 : 0, { origin: m.inherited_from }));
  }
  return out.slice(0, 100);
}
