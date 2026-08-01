/**
 * Bounded working set for tools promoted at runtime.
 *
 * A hidden tool becomes visible after the model calls it by name. Those
 * promotions used to accumulate forever, so a long session eventually made
 * every promoted tool "never trim" and the soft cap stopped being a cap.
 *
 * Set insertion order is the LRU clock:
 *   - touching a dynamic pin moves it to the tail;
 *   - adding a new pin evicts the oldest dynamic entry;
 *   - required/configured pins are permanent and do not consume the dynamic
 *     window.
 *
 * The window changes membership only when a new hidden capability is used.
 * Ordinary calls merely update recency, preserving the provider tool-prefix
 * cache until a real swap is required.
 */

export const DEFAULT_DYNAMIC_TOOL_PIN_LIMIT = 16;

export function resolveDynamicToolPinLimit(): number {
  const raw = Number.parseInt(process.env.CODER_DYNAMIC_TOOL_PIN_LIMIT ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_DYNAMIC_TOOL_PIN_LIMIT;
  return Math.max(1, Math.min(64, raw));
}

export function touchDynamicToolPin(
  pins: Set<string>,
  requiredPins: ReadonlySet<string> | undefined,
  name: string,
): boolean {
  if (requiredPins?.has(name) || !pins.has(name)) return false;
  pins.delete(name);
  pins.add(name);
  return true;
}

export function promoteDynamicToolPin(
  pins: Set<string>,
  requiredPins: ReadonlySet<string> | undefined,
  name: string,
  limit = resolveDynamicToolPinLimit(),
): string[] {
  if (requiredPins?.has(name)) {
    pins.add(name);
    return [];
  }

  // Re-promotion is also a recency signal.
  pins.delete(name);
  pins.add(name);

  const evicted: string[] = [];
  let dynamicCount = 0;
  for (const pin of pins) {
    if (!requiredPins?.has(pin)) dynamicCount++;
  }
  if (dynamicCount <= limit) return evicted;

  for (const pin of [...pins]) {
    if (requiredPins?.has(pin) || pin === name) continue;
    pins.delete(pin);
    evicted.push(pin);
    dynamicCount--;
    if (dynamicCount <= limit) break;
  }
  return evicted;
}

export function normalizeDynamicToolPins(
  pins: Set<string>,
  requiredPins: ReadonlySet<string> | undefined,
  limit = resolveDynamicToolPinLimit(),
): string[] {
  const dynamic = [...pins].filter((name) => !requiredPins?.has(name));
  const overflow = Math.max(0, dynamic.length - limit);
  const evicted = dynamic.slice(0, overflow);
  for (const name of evicted) pins.delete(name);
  for (const name of requiredPins ?? []) pins.add(name);
  return evicted;
}

