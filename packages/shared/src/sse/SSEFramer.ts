/**
 * Pure SSE framer — parses Server-Sent Event wire format.
 *
 * Events are separated by blank lines (\n\n). Each event is a block of
 * lines with `id:`, `event:`, `data:` prefixes. `data:` may appear multiple
 * times (concatenated with newlines per spec).
 *
 * Stateless aside from the incomplete trailing buffer — callers pass the
 * accumulated buffer and receive parsed events plus the remainder.
 */

export interface SSEEvent {
  /** Numeric id if present (used for Last-Event-ID replay). */
  id?: number;
  /** Event name. Defaults to "message" per SSE spec. */
  event: string;
  /** Raw data payload (may be JSON, may be empty). */
  data: string;
}

export interface SSEParseResult {
  events: SSEEvent[];
  /** Portion of input that hasn't completed an event yet; feed back on next call. */
  rest: string;
}

/** Diagnostic for a dropped event block (see `parseSSEChunk` `onError`). */
export interface SSEFrameError {
  reason: 'malformed_block';
  /** Raw block content, truncated to 200 chars for logs. */
  raw: string;
}

export type SSEFrameErrorHandler = (err: SSEFrameError) => void;

/**
 * Parse a chunk of the SSE stream. Returns all complete events and the
 * unconsumed remainder. Never throws on malformed input — malformed event
 * blocks are dropped (matching browser EventSource behavior), but an
 * optional `onError` now receives them for diagnostics. Comment-only
 * keepalive blocks (`: ping`) are dropped silently as before.
 */
export function parseSSEChunk(buffer: string, onError?: SSEFrameErrorHandler): SSEParseResult {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SSEEvent[] = [];

  for (const raw of blocks) {
    if (!raw) continue;
    const ev = parseEventBlock(raw);
    if (ev) events.push(ev);
    else if (onError && looksMalformed(raw)) {
      onError({
        reason: 'malformed_block',
        raw: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw,
      });
    }
  }

  return { events, rest };
}

/** Fields the parser knows about. A block containing one of these is
 *  spec-shaped even when it dispatches no event (e.g. `retry`-only). */
const KNOWN_FIELDS = new Set(['event', 'data', 'id', 'retry']);

/** A dropped block only counts as malformed when it carries real content
 *  lines but no recognizable field — comment-only keepalives (`: ping`) and
 *  field-only blocks (`retry: 3000`) are legitimately dropped in silence. */
function looksMalformed(raw: string): boolean {
  let sawContent = false;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    sawContent = true;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (KNOWN_FIELDS.has(field)) return false;
  }
  return sawContent;
}

function parseEventBlock(raw: string): SSEEvent | null {
  let event = 'message';
  let data = '';
  let id: number | undefined;
  let sawField = false;

  for (const rawLine of raw.split('\n')) {
    // Strip trailing \r for CRLF streams.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // Per spec: if value starts with a single space, trim it.
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value;
      sawField = true;
    } else if (field === 'data') {
      data = data ? data + '\n' + value : value;
      sawField = true;
    } else if (field === 'id') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) id = n;
      sawField = true;
    }
    // Other fields (retry, etc) are ignored.
  }

  if (!sawField) return null;
  return { event, data, id };
}
