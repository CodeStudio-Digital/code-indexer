/** Non-secret fields that identify a configured provider in the UI and the harness. */
export interface CatalogProviderIdentity { id: string; name: string; kind: string; enabled: boolean }

const label = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A model search treats the name and dotted version as separate terms in either order. */
export function catalogTerms(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}]+|\d+(?:\.\d+)*/gu) ?? [];
}

/** Exact configured ID wins, even when disabled. A provider kind can have several accounts. */
export function matchCatalogProviders<T extends CatalogProviderIdentity>(providers: readonly T[], selector: string): T[] {
  const exact = providers.find(p => p.id === selector);
  if (exact) return exact.enabled ? [exact] : [];
  const name = label(selector);
  const named = providers.filter(p => label(p.id) === name || label(p.name) === name);
  if (named.length) return named.filter(p => p.enabled);
  const kind = ['codex', 'chatgpt codex', 'codex chatgpt'].includes(name) ? 'chatgpt' : name;
  return providers.filter(p => p.enabled && label(p.kind) === kind);
}

export function searchCatalogProviders<T extends CatalogProviderIdentity>(providers: readonly T[], query: string): T[] {
  const exact = matchCatalogProviders(providers, query);
  const words = catalogTerms(query);
  if (!words.length) return [];
  return [...exact, ...providers.filter(p => p.enabled && !exact.includes(p) &&
    words.every(word => label(p.id + ' ' + p.name + ' ' + p.kind).includes(word)))];
}

/** Match the longest configured name at the start, preserving the remainder of the instruction. */
export function providerAtStart(tail: string, identities: readonly CatalogProviderIdentity[]) {
  const quoted = /^["'`]([^"'`]+)["'`]/.exec(tail);
  if (quoted) return matchCatalogProviders(identities, quoted[1]).length ? { name: quoted[1], rest: tail.slice(quoted[0].length) } : undefined;
  const phrase = /^[\p{L}\p{N}()_./-]+(?:[ \t]+[\p{L}\p{N}()_./-]+)*/u.exec(tail.slice(0, 256))?.[0];
  if (!phrase) return;
  for (const word of [...phrase.matchAll(/\S+/g)].reverse()) {
    const end = word.index + word[0].length;
    const name = phrase.slice(0, end);
    if (matchCatalogProviders(identities, name).length) return { name, rest: tail.slice(end) };
  }
}
