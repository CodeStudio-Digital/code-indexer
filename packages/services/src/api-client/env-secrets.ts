/**
 * Secret masking for API-client environments. Pure (no I/O) so it's unit
 * testable and shared by the routes. Secret values never leave the server in
 * cleartext: `maskSecrets` replaces them with a sentinel for the GET payload,
 * and `mergeSecrets` restores the stored value whenever the client sends the
 * sentinel back — so editing other fields (or toggling the secret flag off)
 * never clobbers a real secret with the mask.
 */
export const SECRET_MASK = '••••';

export type EnvVarMap = Record<string, { value?: string; secret?: boolean } | string>;

/** Replace secret values with the sentinel for client-facing responses. */
export function maskSecrets(variablesJson: string): string {
  try {
    const obj = JSON.parse(variablesJson) as EnvVarMap;
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && v.secret) v.value = SECRET_MASK;
    }
    return JSON.stringify(obj);
  } catch {
    return variablesJson;
  }
}

/**
 * Restore the real value for any incoming variable whose value is still the
 * sentinel — regardless of its current secret flag. This is the fix for the
 * "untoggle secret persists ••••" bug: the mask is never a value the user
 * actually typed, so any sentinel means "keep what was stored".
 */
export function mergeSecrets(incoming: EnvVarMap, existingJson: string | null | undefined): EnvVarMap {
  let existing: EnvVarMap = {};
  try { existing = existingJson ? (JSON.parse(existingJson) as EnvVarMap) : {}; } catch { /* none */ }
  for (const [k, v] of Object.entries(incoming)) {
    if (v && typeof v === 'object' && v.value === SECRET_MASK) {
      const prev = existing[k];
      v.value = prev && typeof prev === 'object' ? (prev.value ?? '') : (typeof prev === 'string' ? prev : '');
    }
  }
  return incoming;
}
