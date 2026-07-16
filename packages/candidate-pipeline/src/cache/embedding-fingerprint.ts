/**
 * Optional model identity carried by embedding callbacks used by candidate
 * pipelines. Production callbacks should expose a stable, dynamic fingerprint
 * of the backend/model/template that owns the returned vector space.
 */
export interface FingerprintedEmbeddingFunction {
  readonly fingerprint?: () => string;
}

let fallbackSequence = 0;
const fallbackFingerprints = new WeakMap<Function, string>();

/**
 * Resolve the vector-space identity for an embedding callback.
 *
 * Test/local callbacks that do not expose a fingerprint are isolated by
 * function identity. A dynamic production callback must expose fingerprint()
 * so changing its underlying model also changes every cache namespace.
 */
export function resolveEmbeddingFingerprint(
  embed: Function & FingerprintedEmbeddingFunction,
): string {
  if (embed.fingerprint) {
    const fingerprint = embed.fingerprint().trim();
    if (!fingerprint) throw new Error('Embedding fingerprint must not be empty');
    return fingerprint;
  }

  let fallback = fallbackFingerprints.get(embed);
  if (!fallback) {
    fallbackSequence += 1;
    fallback = `embedding-function:${fallbackSequence}`;
    fallbackFingerprints.set(embed, fallback);
  }
  return fallback;
}

/** Guard a pipeline from crossing vector spaces during a concurrent profile edit. */
export function assertEmbeddingFingerprint(
  embed: Function & FingerprintedEmbeddingFunction,
  expected: string,
): void {
  const current = resolveEmbeddingFingerprint(embed);
  if (current !== expected) {
    throw new Error(`Embedding model changed during pipeline execution (${expected} -> ${current})`);
  }
}
