const EXTERNAL_DESCRIPTION_CHARS = 4_096;
const EXTERNAL_SCHEMA_BYTES = 64 * 1_024;
// JSON Schema nesting includes properties/items/oneOf containers, not just
// input-object depth. Real MCP contracts routinely need more than 8 levels.
const EXTERNAL_SCHEMA_DEPTH = 64;
const EXTERNAL_SCHEMA_NODES = 4_096;

/** Bounds untrusted MCP/plugin metadata before it reaches a catalog or provider. */
export function sanitizeUntrustedCapabilityMetadata(
  description: unknown,
  schema: unknown,
): { description: string; schema: object; truncated: boolean; schemaError?: string } {
  let nodes = 0;
  let bytes = 0;
  let truncated = false;
  const ancestors = new WeakSet<object>();
  const spend = (amount: number): void => {
    bytes += amount;
    if (bytes > EXTERNAL_SCHEMA_BYTES) throw new Error('External schema exceeds the 64 KiB metadata budget');
  };
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > EXTERNAL_SCHEMA_NODES || depth > EXTERNAL_SCHEMA_DEPTH) {
      throw new Error('External schema exceeds the depth or node metadata budget');
    }
    if (typeof value === 'string') {
      // Never shorten enum/const/pattern/$ref values or property names: doing
      // so changes the input contract. Bound the entire schema atomically.
      if (value.length > EXTERNAL_SCHEMA_BYTES) throw new Error('External schema string exceeds the metadata budget');
      spend(Buffer.byteLength(JSON.stringify(value), 'utf8'));
      return value;
    }
    if (typeof value === 'boolean' || value === null || (typeof value === 'number' && Number.isFinite(value))) {
      spend(JSON.stringify(value).length);
      return value;
    }
    if (typeof value !== 'object') throw new Error('External schema contains a non-JSON value');
    if (ancestors.has(value)) throw new Error('External schema contains a cycle');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        spend(2 + Math.max(0, value.length - 1));
        return Array.from(value, (item) => visit(item, depth + 1));
      }
      const keys = Object.keys(value);
      if (keys.length > EXTERNAL_SCHEMA_NODES) throw new Error('External schema exceeds the node metadata budget');
      spend(2 + Math.max(0, keys.length - 1));
      return Object.fromEntries(keys.sort().map(key => {
        if (key.length > EXTERNAL_SCHEMA_BYTES) throw new Error('External schema key exceeds the metadata budget');
        spend(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
        return [key, visit((value as Record<string, unknown>)[key], depth + 1)];
      }));
    } finally { ancestors.delete(value); }
  };

  const boundedDescription = typeof description === 'string'
    ? description.slice(0, EXTERNAL_DESCRIPTION_CHARS)
    : '';
  if (typeof description === 'string' && description.length > boundedDescription.length) truncated = true;

  try {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('External tool schema must be an object');
    return { description: boundedDescription, schema: visit(schema, 0) as object, truncated };
  } catch (error) {
    // This is a disabled descriptor, never a permissive replacement contract.
    // Importers must omit it instead of publishing a partially damaged schema.
    return { description: boundedDescription,
      schema: { type: 'object', properties: {}, not: {} }, truncated: true,
      schemaError: error instanceof Error ? error.message : 'Invalid external schema' };
  }
}
