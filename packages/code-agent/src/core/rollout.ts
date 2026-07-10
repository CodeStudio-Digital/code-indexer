/** Deterministic percentage rollout. Values outside 0..100 use the fallback. */
export function rolloutEnabled(
  envName: string,
  key: string,
  fallbackPercent = 100,
): boolean {
  const raw = process.env[envName];
  const parsed = raw == null || raw === '' ? fallbackPercent : Number(raw);
  const percent = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : fallbackPercent;
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  let hash = 0x811c9dc5 >>> 0;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) / 0x100000000 < percent / 100;
}
