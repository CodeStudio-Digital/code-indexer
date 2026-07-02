/**
 * T1 — members available on the expression at the cursor. THE fix for the
 * "completer ignores my classes" complaint: when the user types `Cls::` or
 * `$x->`, inject that receiver's real methods/properties into the prompt.
 *
 * Two sources, LSP-first:
 *  - LSP (intelephense/pyright), ONLY when a server is already `ready` — never
 *    waits a cold boot; bounded by a configurable race (default 250ms — the
 *    old 60ms NEVER won even against warm servers, telemetry showed 0% LSP).
 *    Resolves typed `$var->`, inherited members, traits, vendor/magic methods.
 *  - Structural index fallback: receiver → class (via the shared
 *    resolveReceiverClass, plus local buffer inference for typed `$var->`) →
 *    getClassMembersDeep (inherited + trait members via the relations walk).
 * Member text is micro-cached per (project,file,receiver,prefix) so a typing
 * burst pays at most one LSP round-trip.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CompletionItem } from '@mcp/api-bus';
import type { DBSymbol } from '@mcp/shared/types.js';
import {
  detectMemberTrigger,
  resolveReceiverClass,
  type MemberTrigger,
} from '../../lsp/fallback-members.js';
import { ensureLspManager, serverCompletion } from '../../lsp/server-backend.js';
import { TtlLru } from '../completion-context.js';
import { memberLine, clampToBudget } from './render.js';
import { inferReceiverClass } from './snippets/infer-receiver.js';

export type MemberSource = 'lsp' | 'index' | 'none';
/** How the receiver's class got resolved ('local' = buffer inference). */
export type InferSource = 'lsp' | 'index' | 'local' | 'none';

export interface ReceiverMembersInput {
  db: CodeIndexDB;
  projectId: number;
  file: string;
  language: string;
  position: { line: number; col: number };
  /** Current line up to the cursor (last line of the trimmed prefix). */
  lastPrefixLine: string;
  syms: DBSymbol[];
  budgetChars: number;
  /** Full live buffer — enables local type inference for `$var->`/`x.`. */
  docContent?: string;
  /** LSP race budget override (ms). */
  lspRaceMs?: number;
}

export interface ReceiverMembersResult {
  text: string;
  chars: number;
  source: MemberSource;
  /** Receiver label for the prompt heading, e.g. "LoyaltyServiceModel (static)". */
  label: string;
  count: number;
  /** A `::`/`->` member trigger was detected (even if it resolved to nothing). */
  triggered: boolean;
  inferSource: InferSource;
}

const EMPTY: ReceiverMembersResult = {
  text: '', chars: 0, source: 'none', label: '', count: 0, triggered: false, inferSource: 'none',
};
const TRIGGERED_EMPTY: ReceiverMembersResult = { ...EMPTY, triggered: true };
/** Languages where `.` is member access (not concat/range) — opt into dot detection. */
const DOT_MEMBER_LANG = /^(typescript|javascript|typescriptreact|javascriptreact|tsx|jsx|python|java|csharp|c#|go|kotlin|scala|swift|dart)$/i;
const LSP_MEMBER_TIMEOUT_MS = 250;
const MAX_MEMBERS = 30;
/** Kinds that are noise as "members of a receiver" — exclude, keep the rest. */
const NOISE_KINDS = new Set([
  'keyword', 'snippet', 'text', 'module', 'file', 'folder', 'color', 'unit', 'event', 'operator',
]);

// Module-level (shared across the dual factory instances on Electron). Short
// TTL: a class body changes only on edit, and the LSP path is position-bound.
const memberCache = new TtlLru<ReceiverMembersResult>(64, 5_000);

/** Odd count of unescaped quotes before the cursor ⇒ inside a string literal. */
function insideString(line: string): boolean {
  let dq = 0;
  let sq = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (c === '"') dq++;
    else if (c === "'") sq++;
  }
  return dq % 2 === 1 || sq % 2 === 1;
}

function receiverLabel(trigger: MemberTrigger, className: string | null): string {
  const access = trigger.access === 'static' ? 'static' : 'instance';
  return `${className ?? trigger.receiver} (${access})`;
}

export async function receiverMembers(input: ReceiverMembersInput): Promise<ReceiverMembersResult> {
  const { db, projectId, file, language, position, lastPrefixLine, syms, budgetChars } = input;
  if (budgetChars <= 0) return EMPTY;

  // 1-based column: windows.prefix ends AT the cursor, so the last line's
  // length + 1 is the cursor column (matches input.position.col).
  const col = lastPrefixLine.length + 1;
  const trigger = detectMemberTrigger(lastPrefixLine, col, { dot: DOT_MEMBER_LANG.test(language) });
  if (!trigger.access) return EMPTY;
  if (insideString(lastPrefixLine)) return EMPTY; // string/comment guard

  const cacheKey = `${projectId}:${file}:${trigger.receiver}:${trigger.prefix}`;
  const cached = memberCache.get(cacheKey);
  if (cached) return cached.chars > budgetChars ? reclamp(cached, budgetChars) : cached;

  // LSP-first (warm servers only — gated below).
  const viaLsp = await tryLspMembers(input, trigger);
  if (viaLsp) { memberCache.set(cacheKey, viaLsp); return viaLsp; }

  // Index fallback: receiver → class → members (inherited via relations walk).
  // Typed receivers ($var->, x.) that resolveReceiverClass can't name are
  // inferred from the buffer (assignments/annotations/param hints) instead.
  let inferSource: InferSource = 'index';
  let className = resolveReceiverClass(trigger, syms, position.line);
  if (!className && input.docContent) {
    className = inferReceiverClass(input.docContent, trigger.receiver, position.line, language);
    if (className) inferSource = 'local';
  }
  if (!className) return TRIGGERED_EMPTY;
  const members = collectIndexMembers(db, projectId, className, trigger);
  if (members.length === 0) return TRIGGERED_EMPTY;
  const { text, chars } = clampToBudget(members.map(memberLine), budgetChars);
  if (!text) return TRIGGERED_EMPTY;
  const result: ReceiverMembersResult = {
    text, chars, source: 'index', label: receiverLabel(trigger, className),
    count: members.length, triggered: true, inferSource,
  };
  memberCache.set(cacheKey, result);
  return result;
}

function reclamp(r: ReceiverMembersResult, budgetChars: number): ReceiverMembersResult {
  const { text, chars } = clampToBudget(r.text.split('\n'), budgetChars);
  return { ...r, text, chars };
}

async function tryLspMembers(
  input: ReceiverMembersInput, trigger: MemberTrigger,
): Promise<ReceiverMembersResult | null> {
  const { db, projectId, file, language, position, budgetChars } = input;
  let ready = false;
  try { ready = ensureLspManager(db).status(projectId, language).state === 'ready'; } catch { ready = false; }
  if (!ready) return null;
  const root = db.getProject(projectId)?.root_path;
  if (!root) return null;

  const SENTINEL = Symbol('lsp-member-timeout');
  const raceMs = input.lspRaceMs ?? LSP_MEMBER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const items = await Promise.race([
    serverCompletion(
      db, projectId, root, file, language,
      { line: position.line, column: position.col }, { triggerKind: 1 },
    ).catch(() => null),
    new Promise<typeof SENTINEL>((r) => { timer = setTimeout(() => r(SENTINEL), raceMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (items === SENTINEL || !Array.isArray(items) || items.length === 0) return null;

  const lines = lspMemberLines(items as CompletionItem[], trigger.prefix);
  if (lines.length === 0) return null;
  const { text, chars } = clampToBudget(lines, budgetChars);
  if (!text) return null;
  return {
    text, chars, source: 'lsp', label: receiverLabel(trigger, null),
    count: lines.length, triggered: true, inferSource: 'lsp',
  };
}

function lspMemberLines(items: CompletionItem[], prefix: string): string[] {
  const lower = prefix.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const label = typeof i.label === 'string' ? i.label : '';
    if (!label) continue;
    if (lower && !label.toLowerCase().startsWith(lower)) continue;
    if (i.kind && NOISE_KINDS.has(i.kind.toLowerCase())) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    const detail = (i.detail ?? i.labelDetails?.detail ?? i.labelDetails?.description ?? '').trim();
    out.push(detail ? `${label} ${detail}` : label);
    if (out.length >= MAX_MEMBERS) break;
  }
  return out;
}

/**
 * Members of `className` INCLUDING inherited/trait members — delegates to the
 * shared relations walk (db.getClassMembersDeep: extends/implements/mixes,
 * cycle-guarded, own members shadow ancestors'). Prefix-filtered, deduped by
 * name, capped at MAX_MEMBERS. No static-only filter: this is HINT context
 * (recall over strictness), and PHP magic statics (`Model::where`) would be
 * lost by a strict filter anyway.
 */
function collectIndexMembers(
  db: CodeIndexDB, projectId: number, className: string, trigger: MemberTrigger,
): DBSymbol[] {
  let members: DBSymbol[];
  try {
    members = db.getClassMembersDeep(projectId, className).members;
  } catch {
    members = db.getClassMembers(className, projectId); // deep walk is best-effort
  }
  const seen = new Set<string>();
  const out: DBSymbol[] = [];
  for (const m of members) {
    if (trigger.prefix && !m.name.startsWith(trigger.prefix)) continue;
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    out.push(m);
    if (out.length >= MAX_MEMBERS) break;
  }
  return out;
}
