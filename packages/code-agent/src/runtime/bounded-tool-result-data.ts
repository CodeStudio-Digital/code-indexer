/** Structured UI data is optional; it must neither make a successful effect
 * look failed nor monopolize serialization with an unbounded object graph. */
export function boundedToolResultData(value: unknown, maximumBytes: number): {
  structuredData?: unknown; structuredDataOmitted?: 'invalid' | 'too_large';
} {
  if (value === undefined) return {};
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const add = (size: number) => { bytes += size; if (bytes > maximumBytes) throw new RangeError('budget'); };
  const text = (value: string) => {
    if (value.length > maximumBytes) throw new RangeError('budget');
    add(Buffer.byteLength(JSON.stringify(value))); return value;
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 24) throw new RangeError('budget');
    if (typeof item === 'string') return text(item);
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) {
      add(String(item).length); return item;
    }
    if (!item || typeof item !== 'object' || active.has(item)) throw new Error('invalid');
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('invalid');
    active.add(item); add(2);
    try {
      if (array) {
        if (item.length > 8192) throw new RangeError('budget');
        const result = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (descriptor && !('value' in descriptor)) throw new Error('invalid');
          result.push(visit(descriptor?.value ?? null, depth + 1)); add(1);
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key in item) {
        if (++nodes > 8192) throw new RangeError('budget');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor) continue;
        if (!('value' in descriptor)) throw new Error('invalid');
        if (descriptor.value === undefined) continue;
        text(key); add(2); result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { active.delete(item); }
  };
  try { return { structuredData: visit(value, 0) }; }
  catch (cause) { return { structuredDataOmitted: cause instanceof RangeError ? 'too_large' : 'invalid' }; }
}
