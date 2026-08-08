const EXTERNAL_DESCRIPTION_CHARS = 4_096;
const EXTERNAL_SCHEMA_BYTES = 64 * 1_024;
const EXTERNAL_SCHEMA_DEPTH = 8;
const EXTERNAL_SCHEMA_NODES = 4_096;

/** Bounds untrusted MCP/plugin metadata before it reaches a catalog or provider. */
export function sanitizeUntrustedCapabilityMetadata(
  description: unknown,
  schema: unknown,
): { description: string; schema: object; truncated: boolean } {
  let nodes = 0;
  let truncated = false;
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > EXTERNAL_SCHEMA_NODES || depth > EXTERNAL_SCHEMA_DEPTH) {
      truncated = true;
      return null;
    }
    if (typeof value === 'string') {
      if (value.length > EXTERNAL_DESCRIPTION_CHARS) truncated = true;
      return value.slice(0, EXTERNAL_DESCRIPTION_CHARS);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) {
      if (value.length > 128) truncated = true;
      return value.slice(0, 128).map((item) => visit(item, depth + 1));
    }
    if (!value || typeof value !== 'object') return null;
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length > 256) truncated = true;
    return Object.fromEntries(entries.slice(0, 256).map(([key, nested]) => [
      key.slice(0, 256),
      visit(nested, depth + 1),
    ]));
  };

  const boundedDescription = typeof description === 'string'
    ? description.slice(0, EXTERNAL_DESCRIPTION_CHARS)
    : '';
  if (typeof description === 'string' && description.length > boundedDescription.length) truncated = true;

  let boundedSchema = visit(schema, 0);
  if (!boundedSchema || typeof boundedSchema !== 'object' || Array.isArray(boundedSchema)) {
    boundedSchema = { type: 'object', properties: {} };
    truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(boundedSchema), 'utf8') > EXTERNAL_SCHEMA_BYTES) {
    boundedSchema = {
      type: 'object',
      properties: {},
      additionalProperties: true,
      $comment: 'External schema exceeded the local metadata budget and was omitted.',
    };
    truncated = true;
  }

  return { description: boundedDescription, schema: boundedSchema as object, truncated };
}
