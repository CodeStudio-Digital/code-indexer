/**
 * Cheap local type inference for member completion — resolves the class of a
 * typed receiver (`$var->`, `x.`) that the structural index alone cannot
 * (resolveReceiverClass returns null for those). Pure string scanning over
 * the CURRENT buffer, nearest-match-wins, zero IO — the LSP path still wins
 * when a server is warm; this is the fallback that turns the telemetry's
 * "memberSource: none 95%" into real member hints.
 */
import { inferPhpVariableClass } from '../../../lsp/fallback-members.js';

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const TYPE = '[A-Za-z_][A-Za-z0-9_.]*';

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Last regex match (first capture group) in `text`, or null. */
function lastMatch(text: string, re: RegExp): { index: number; type: string } | null {
  let best: { index: number; type: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) best = { index: m.index, type: m[1]! };
  return best;
}

/**
 * PHP extras beyond inferPhpVariableClass: parameter type hints on any
 * function/method signature above the cursor — `function foo(Cls $x)` and
 * promoted ctor props `public Cls $x`.
 */
function phpParamHint(before: string, varName: string): { index: number; type: string } | null {
  const name = esc(varName);
  const param = new RegExp(
    `[(,]\\s*(?:public\\s+|protected\\s+|private\\s+|readonly\\s+)*\\??\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)\\s+\\$${name}\\b`,
    'g',
  );
  const hit = lastMatch(before, param);
  if (!hit) return null;
  const short = hit.type.split('\\').pop()!;
  // Scalar hints are not classes the index knows members for.
  if (/^(int|float|string|bool|array|mixed|object|callable|iterable|self|static|null|void)$/i.test(short)) return null;
  return { index: hit.index, type: short };
}

function inferPhp(content: string, receiver: string, line: number): string | null {
  const fromAssignments = inferPhpVariableClass(content, receiver, line);
  const before = content.split('\n').slice(0, Math.max(0, line - 1)).join('\n');
  const fromParam = receiver.startsWith('$') ? phpParamHint(before, receiver.slice(1)) : null;
  if (!fromAssignments) return fromParam?.type ?? null;
  if (!fromParam) return fromAssignments;
  // inferPhpVariableClass already picked ITS nearest match; compare against the
  // param hint's position so the assignment nearest the cursor wins overall.
  const name = esc(receiver.slice(1));
  const assignRe = new RegExp(`\\$${name}\\s*=\\s*(?:new\\s+)?\\\\?[A-Za-z_]|@var\\s+\\\\?[A-Za-z_][^\\n]*\\$${name}\\b`, 'g');
  const lastAssign = lastMatch(before, assignRe as RegExp);
  return (lastAssign?.index ?? -1) >= fromParam.index ? fromAssignments : fromParam.type;
}

function inferTsJs(before: string, receiver: string): string | null {
  const name = esc(receiver);
  const patterns: RegExp[] = [
    // const x = new Cls(   |  x = await Cls.create(
    new RegExp(`(?:const|let|var)?\\s*${name}\\s*=\\s*(?:await\\s+)?new\\s+(${TYPE})\\s*[(<]`, 'g'),
    new RegExp(`(?:const|let|var)?\\s*${name}\\s*=\\s*await\\s+(${TYPE})\\.(?:create|getInstance|from|of)\\s*\\(`, 'g'),
    // x: Cls  (annotation — declaration or parameter)
    new RegExp(`\\b${name}\\s*:\\s*(${TYPE})\\b`, 'g'),
    // x = y as Cls
    new RegExp(`\\b${name}\\s*=\\s*[^;\\n]*\\bas\\s+(${TYPE})\\b`, 'g'),
  ];
  let best: { index: number; type: string } | null = null;
  for (const re of patterns) {
    const hit = lastMatch(before, re);
    if (hit && (!best || hit.index > best.index)) best = hit;
  }
  if (!best) return null;
  const short = best.type.split('.').pop()!;
  if (/^(string|number|boolean|any|unknown|void|object|never|Array|Promise)$/.test(short)) return null;
  return short;
}

function inferPython(before: string, receiver: string): string | null {
  const name = esc(receiver);
  const patterns: RegExp[] = [
    new RegExp(`\\b${name}\\s*:\\s*["']?(${TYPE})["']?`, 'g'),      // x: Cls (var or def param)
    new RegExp(`\\b${name}\\s*=\\s*(${TYPE})\\s*\\(`, 'g'),          // x = Cls(
  ];
  let best: { index: number; type: string } | null = null;
  for (const re of patterns) {
    const hit = lastMatch(before, re);
    if (hit && (!best || hit.index > best.index)) best = hit;
  }
  if (!best) return null;
  const short = best.type.split('.').pop()!;
  if (/^(int|float|str|bool|list|dict|set|tuple|bytes|object|None|Any|Optional)$/i.test(short)) return null;
  return short;
}

/**
 * Infer the class name of `receiver` from assignments/annotations in the
 * buffer above `line` (1-based). Nearest match before the cursor wins.
 * Returns the SHORT class name (index lookups are short-name keyed) or null.
 */
export function inferReceiverClass(
  content: string,
  receiver: string,
  line: number,
  language: string,
): string | null {
  if (!receiver) return null;
  try {
    if (/^php$/i.test(language)) return inferPhp(content, receiver, line);
    const before = content.split('\n').slice(0, Math.max(0, line - 1)).join('\n');
    if (/^(typescript|javascript|typescriptreact|javascriptreact|tsx|jsx)$/i.test(language)) {
      return inferTsJs(before, receiver);
    }
    if (/^python$/i.test(language)) return inferPython(before, receiver);
    return null;
  } catch {
    return null;
  }
}

// Matches the IDENT charset used by the member-trigger detector; exported so
// tests can assert the contract without duplicating the constant.
export const RECEIVER_IDENT_RE = new RegExp(`^${IDENT}$`);
