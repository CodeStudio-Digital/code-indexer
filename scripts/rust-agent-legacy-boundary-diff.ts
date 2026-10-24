/** Compare imported symbols, so removing one name cannot look like an addition. */
export function diffLegacyBoundary(current: readonly string[], baseline: readonly string[]) {
  const actual = symbolsByModule(current), allowed = symbolsByModule(baseline);
  return { additions: subtract(actual, allowed), removals: subtract(allowed, actual) };
}
function symbolsByModule(references: readonly string[]): Map<string, Set<string>> {
  const modules = new Map<string, Set<string>>();
  for (const reference of references) {
    const parts = reference.split('::');
    if (parts.length !== 4 || parts.slice(0, 3).some(part => !part)) throw new Error('Invalid legacy boundary reference');
    // Literal package/path references have no symbols but remain a dependency.
    const symbols = parts.pop()!.split(',');
    const key = parts.map(part => part.replaceAll('\\', '/')).join('::');
    let entries = modules.get(key);
    if (!entries) { entries = new Set(); modules.set(key, entries); }
    for (const symbol of symbols) entries.add(symbol);
  }
  return modules;
}
function subtract(left: Map<string, Set<string>>, right: Map<string, Set<string>>): string[] {
  const differences: string[] = [];
  for (const [key, symbols] of left) {
    const missing = [...symbols].filter(symbol => !right.get(key)?.has(symbol)).sort();
    if (missing.length) differences.push(key + '::' + missing.join(','));
  }
  return differences.sort();
}
