import { ApiToken, type McpTier } from '../domain/api-token.js';
import { ScopeSet } from '../domain/scope.js';
import type { ApiTokenAdminRepo } from '../ports/api-token-repository.js';
import type { Clock } from '../ports/clock.js';
import type { RandomId } from '../ports/random-id.js';
import type { TokenHasher } from '../ports/token-hasher.js';

export interface IssueInput {
  name: string;
  scopes: readonly string[];
  expiresInDays?: number;
  /**
   * Optional tier binding. When set, the MCP HTTP transport filters the
   * tool catalog (tools/list) and gates execution (tools/call) so this
   * token only sees / runs tools at this tier or below. Omit to fall
   * back to plain scope-based RBAC.
   */
  tier?: McpTier | null;
}

export interface IssueOutput {
  id: string;
  rawToken: string;
}

/**
 * IssueApiToken — mints a new token, persists its hash, returns the raw
 * value exactly once. After this call the system cannot recover the raw
 * token (same UX as GitHub PAT).
 */
export class IssueApiToken {
  constructor(
    private readonly repo: ApiTokenAdminRepo,
    private readonly hasher: TokenHasher,
    private readonly random: RandomId,
    private readonly clock: Clock,
  ) {}

  execute(input: IssueInput): IssueOutput {
    const id = this.random.uuid();
    const rawToken = this.random.token(32);
    const now = this.clock.now();
    const expiresAt = input.expiresInDays
      ? now + input.expiresInDays * 86_400_000
      : null;

    const token = ApiToken.issue({
      id,
      tokenHash: this.hasher.hash(rawToken),
      name: input.name,
      scopes: ScopeSet.of(input.scopes),
      expiresAt,
      now,
      tier: input.tier ?? null,
    });

    this.repo.insert(token);
    return { id, rawToken };
  }
}
