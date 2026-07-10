/** Normalize an optional tree preference saved by the connection dialog. */
export function preferredTreeName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Restrict discovered catalog/schema names to the configured one. Preserve the
 * server's canonical casing when it reported a match; otherwise keep the saved
 * name so the tree makes a stale or mistyped preference visible instead of
 * silently falling back to every catalog/schema.
 */
export function restrictTreeNames(names: string[], preferred: unknown): string[] {
  const wanted = preferredTreeName(preferred);
  if (!wanted) return names;
  const match = names.find((name) => name.localeCompare(wanted, undefined, { sensitivity: 'accent' }) === 0);
  return [match ?? wanted];
}
