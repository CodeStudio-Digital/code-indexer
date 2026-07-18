/**
 * json-crush — a CONTENT-TYPE reducer for large structured tool outputs.
 *
 * The per-tool SMART_REDUCERS (git_log, grep, run_command, …) key off the TOOL
 * NAME. But a lot of context waste comes from generic tools (MCP servers,
 * code_exec) that return big, redundant JSON arrays / NDJSON and have no
 * name-specific reducer — those fall through to a blind head-cut. This reducer
 * keys off the CONTENT TYPE instead. When a tool result is a JSON array (or
 * NDJSON) it:
 *
 *   1. drops exact-duplicate rows,
 *   2. (optionally) ranks rows by lexical overlap with the current user query,
 *   3. always keeps the first/last few rows as anchors (top results / latest),
 *   4. fills a char budget (~cap) with the highest-ranked survivors,
 *   5. emits a deterministic marker describing what was elided.
 *
 * Like every reducer it is deterministic (stable sort; the marker depends only
 * on counts, never on turn/context) and idempotent (no-op when the content
 * already fits the cap). The shaped bytes are produced once at tool-finalize
 * time and persisted, so they stay byte-stable across turns and never thrash
 * the prefix cache — even though the query-relevance step is query-dependent,
 * the reducer is never re-run on resume (that path uses buildToolResultBlock).
 *
 * The shaped representation is intentionally lossy, but the runner finalizer
 * receives both raw and shaped values and spills the raw payload whenever this
 * reducer applies. That keeps omitted rows recoverable through output_id.
 */

export interface JsonCrushInput {
  content: string;
  cap: number;
  /** Latest user-turn text; when present, rows are ranked by overlap with it. */
  query?: string;
  /** Tool arguments add stable, call-local relevance terms to row ranking. */
  args?: Record<string, unknown>;
  /** Error payloads preferentially retain rows that look like failures/stacks. */
  isError?: boolean;
  /** Optional producer hint (for example application/json or ndjson). */
  contentFormat?: string;
}

export interface JsonCrushOutput {
  content: string;
  /** True only when the reducer actually shrank the content. */
  applied: boolean;
}

/** Min rows before crushing is worthwhile (small arrays aren't the problem). */
const MIN_ROWS = 8;
/** Rows kept verbatim at each end regardless of score. */
const ANCHOR = 3;
/** Above this, bail to the blind head-cut to avoid pathological latency. */
const MAX_ROWS = 50_000;
/** Reserve for the trailing marker so the result stays near `cap`. */
const MARKER_RESERVE = 200;
/** Fraction of non-empty lines that must parse as JSON to treat as NDJSON. */
const NDJSON_MIN_RATIO = 0.8;
/** Cap on query text fed to the tokenizer (guards against giant prompts). */
const QUERY_MAX = 4000;
/** Avoid a full JSON.parse allocation for pathological single-payload arrays. */
const MAX_PARSE_CHARS = 8_000_000;

/** Count top-level array entries without allocating/parsing the whole value. */
function topLevelArrayRows(text: string, stopAfter: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let rows = 0;
  let sawValue = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[' || ch === '{') { depth++; if (depth === 1 && ch === '[') continue; }
    else if (ch === ']' || ch === '}') depth--;
    else if (depth === 1 && ch === ',') {
      rows++;
      if (rows > stopAfter) return rows;
    } else if (depth === 1 && !/\s/.test(ch)) {
      sawValue = true;
    }
  }
  return sawValue ? rows + 1 : 0;
}

interface Row {
  /** Original index — drives output ordering and the stable tie-break. */
  idx: number;
  /** Serialized text used for dedup, scoring and re-emit. */
  text: string;
  /** Parsed value, retained only for JSON arrays/envelopes when re-emitting. */
  value?: unknown;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
}

const ENVELOPE_KEYS = ['data', 'results', 'items'] as const;

interface ParsedRows {
  rows: Row[];
  mode: 'array' | 'ndjson' | 'envelope';
  envelope?: {
    key: (typeof ENVELOPE_KEYS)[number];
    value: Record<string, unknown>;
  };
}

/** Parse content into rows + the shape to re-serialize as, or null if N/A. */
function parseRows(content: string, contentFormat?: string): ParsedRows | null {
  let trimmed = content.trim();
  // Some MCP/HTTP producers wrap declared JSON in a markdown fence. Only
  // unwrap when the producer explicitly identifies the payload as JSON.
  if (/json/i.test(contentFormat ?? '')) {
    const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/i.exec(trimmed);
    if (fenced) trimmed = fenced[1].trim();
  }
  // Top-level JSON array.
  if (trimmed.startsWith('[')) {
    if (trimmed.length > MAX_PARSE_CHARS) return null;
    const preflightRows = topLevelArrayRows(trimmed, MAX_ROWS);
    if (preflightRows == null || preflightRows > MAX_ROWS) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length >= MIN_ROWS && parsed.length <= MAX_ROWS) {
        return {
          mode: 'array',
          rows: parsed.map((value, idx) => ({ idx, value, text: JSON.stringify(value) })),
        };
      }
    } catch {
      /* not a single JSON array — fall through */
    }
    return null;
  }

  // Common API/MCP envelopes: { data: [...] }, { results: [...] },
  // { items: [...] }. Preserve all sibling metadata and the original array
  // key so callers do not have to learn a reducer-specific response shape.
  if (trimmed.startsWith('{') && trimmed.length <= MAX_PARSE_CHARS) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const envelope = value as Record<string, unknown>;
        const key = ENVELOPE_KEYS.find((candidate) => Array.isArray(envelope[candidate]));
        const values = key ? envelope[key] as unknown[] : null;
        if (key && values && values.length >= MIN_ROWS && values.length <= MAX_ROWS) {
          return {
            mode: 'envelope',
            envelope: { key, value: envelope },
            rows: values.map((row, idx) => ({ idx, value: row, text: JSON.stringify(row) })),
          };
        }
      }
    } catch {
      /* not a single JSON object — fall through to NDJSON detection */
    }
  }

  // NDJSON: many non-empty lines, most of which parse as JSON objects/arrays.
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < MIN_ROWS || lines.length > MAX_ROWS) return null;
  let ok = 0;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(t); ok++; } catch { /* not json */ }
    }
  }
  if (ok / lines.length < NDJSON_MIN_RATIO) return null;
  return { mode: 'ndjson', rows: lines.map((text, idx) => ({ idx, text })) };
}

function boundedArgsText(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  try {
    return JSON.stringify(args).slice(0, QUERY_MAX);
  } catch {
    return '';
  }
}

export function jsonCrush({
  content,
  cap,
  query,
  args,
  isError = false,
  contentFormat,
}: JsonCrushInput): JsonCrushOutput {
  const pass: JsonCrushOutput = { content, applied: false };
  const safeCap = Number.isFinite(cap) && cap > 0 ? Math.max(1, Math.floor(cap)) : 1;
  if (content.length <= safeCap) return pass;
  const parsed = parseRows(content, contentFormat);
  if (!parsed) return pass;
  const { rows, mode } = parsed;

  // 1. Dedup exact-duplicate rows (keep first occurrence).
  const seen = new Set<string>();
  const unique: Row[] = [];
  let duplicates = 0;
  for (const r of rows) {
    if (seen.has(r.text)) { duplicates++; continue; }
    seen.add(r.text);
    unique.push(r);
  }

  // 2. Score by lexical overlap with the query (0 when no query → order kept).
  const relevanceText = [query?.slice(0, QUERY_MAX) ?? '', boundedArgsText(args)]
    .filter(Boolean)
    .join(' ')
    .slice(0, QUERY_MAX);
  const qtokens = relevanceText ? new Set(tokenize(relevanceText)) : null;
  const score = (text: string): number => {
    let hits = 0;
    if (qtokens && qtokens.size > 0) {
      for (const t of new Set(tokenize(text))) if (qtokens.has(t)) hits++;
    }
    // A structured error result often contains a few decisive failure rows
    // surrounded by verbose successes/debug records. Keep those rows even
    // when the latest user query does not contain the exact error vocabulary.
    if (isError && /\b(error|failed?|failure|exception|fatal|panic|stack|traceback)\b/i.test(text)) {
      hits += 100;
    }
    return hits;
  };

  // 3. Anchors: the first/last ANCHOR rows (original order) always survive.
  const keep = new Set<number>();
  for (const r of unique.slice(0, ANCHOR)) keep.add(r.idx);
  for (const r of unique.slice(Math.max(ANCHOR, unique.length - ANCHOR))) keep.add(r.idx);

  // 4. Budget fill: remaining rows by score desc, then original index asc.
  const budget = Math.max(0, safeCap - MARKER_RESERVE);
  let used = unique.filter((r) => keep.has(r.idx)).reduce((n, r) => n + r.text.length + 1, 0);
  const middle = unique
    .filter((r) => !keep.has(r.idx))
    .map((r) => ({ r, s: score(r.text) }))
    .sort((a, b) => b.s - a.s || a.r.idx - b.r.idx);
  for (const { r } of middle) {
    const cost = r.text.length + 1;
    if (used + cost > budget) continue;
    keep.add(r.idx);
    used += cost;
  }

  const kept = unique.filter((r) => keep.has(r.idx)).sort((a, b) => a.idx - b.idx);
  const elided = unique.length - kept.length;
  if (duplicates === 0 && elided === 0) return pass; // nothing saved

  const meta = {
    technique: 'json-crush',
    ...(mode === 'envelope' ? { source_key: parsed.envelope!.key } : {}),
    kept: kept.length,
    total: rows.length,
    duplicates,
    elided,
  };
  // Keep the shaped value machine-readable. Arrays become a documented
  // envelope; NDJSON receives one valid JSON metadata row.
  let out: string;
  if (mode === 'array') {
    out = `{"_smart_reducer":${JSON.stringify(meta)},"rows":[${kept.map((r) => r.text).join(',')}]} `;
  } else if (mode === 'envelope') {
    const envelope = { ...parsed.envelope!.value };
    envelope[parsed.envelope!.key] = kept.map((r) => r.value);
    envelope._smart_reducer = meta;
    out = JSON.stringify(envelope);
  } else {
    out = `${JSON.stringify({ _smart_reducer: meta })}\n${kept.map((r) => r.text).join('\n')}`;
  }
  if (out.length > safeCap) {
    const first = unique[0]?.text ?? '';
    const last = unique.at(-1)?.text ?? '';
    const overhead = JSON.stringify({ _smart_reducer: meta, first: '', last: '' }).length;
    const room = Math.max(0, safeCap - overhead);
    const firstRoom = Math.ceil(room / 2);
    const lastRoom = Math.max(0, room - firstRoom);
    let firstValue = first.slice(0, firstRoom);
    let lastValue = lastRoom > 0 ? last.slice(0, lastRoom) : '';
    const compact = (): string => JSON.stringify({
      _smart_reducer: { ...meta, anchors_compacted: true },
      first: firstValue,
      last: lastValue,
    });
    out = compact();
    while (out.length > safeCap && (firstValue.length > 0 || lastValue.length > 0)) {
      if (firstValue.length >= lastValue.length) firstValue = firstValue.slice(0, Math.floor(firstValue.length * 0.75));
      else lastValue = lastValue.slice(0, Math.floor(lastValue.length * 0.75));
      out = compact();
    }
    if (out.length > safeCap) {
      const metadataOnly = JSON.stringify({ _smart_reducer: meta });
      const minimal = JSON.stringify({ _smart_reducer: { technique: 'json-crush', total: rows.length } });
      out = metadataOnly.length <= safeCap
        ? metadataOnly
        : minimal.length <= safeCap
          ? minimal
          : safeCap >= 2 ? '{}' : '0';
    }
  }
  if (out.length >= content.length) return pass; // reducer didn't help
  return { content: out, applied: true };
}
