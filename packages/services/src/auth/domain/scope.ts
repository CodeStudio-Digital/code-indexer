/**
 * Scope VO — single scope string like "mcp:read", "mcp:write", "mcp:admin".
 * Hierarchy: 'mcp:admin' implies 'mcp:write' implies 'mcp:read'.
 */
export const KNOWN_SCOPES = ['mcp:read', 'mcp:write', 'mcp:admin'] as const;
export type KnownScope = (typeof KNOWN_SCOPES)[number];

const HIERARCHY: Record<KnownScope, readonly KnownScope[]> = {
  'mcp:admin': ['mcp:admin', 'mcp:write', 'mcp:read'],
  'mcp:write': ['mcp:write', 'mcp:read'],
  'mcp:read': ['mcp:read'],
};

export function isKnownScope(s: string): s is KnownScope {
  return (KNOWN_SCOPES as readonly string[]).includes(s);
}

export class ScopeSet {
  private readonly set: ReadonlySet<string>;

  private constructor(scopes: readonly string[]) {
    this.set = new Set(scopes);
  }

  static of(scopes: readonly string[]): ScopeSet {
    return new ScopeSet(scopes);
  }

  static fromJson(json: string): ScopeSet {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new Error('ScopeSet JSON must be an array of strings');
    }
    return new ScopeSet(parsed);
  }

  values(): readonly string[] {
    return [...this.set];
  }

  toJson(): string {
    return JSON.stringify(this.values());
  }

  /**
   * True if this set grants `required`, directly or via hierarchy.
   */
  grants(required: string): boolean {
    if (this.set.has(required)) return true;
    if (!isKnownScope(required)) return false;
    for (const held of this.set) {
      if (isKnownScope(held) && HIERARCHY[held].includes(required)) return true;
    }
    return false;
  }

  intersect(other: ScopeSet): ScopeSet {
    return ScopeSet.of(this.values().filter((s) => other.set.has(s)));
  }

  isEmpty(): boolean {
    return this.set.size === 0;
  }
}
