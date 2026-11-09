export interface OAuthAttempt {
  state: string;
  serverId: string;
  expiresAt: number;
  status: 'pending' | 'exchanging' | 'authenticated' | 'error';
  error?: string;
}

/** Completion belongs to one flow, independent of token refreshes or client clocks. */
export class McpOAuthAttempts {
  private readonly attempts = new Map<string, OAuthAttempt>();
  begin(serverId: string, state: string): OAuthAttempt {
    this.cancel(serverId);
    for (const [key, value] of this.attempts) if (value.expiresAt < Date.now()) this.attempts.delete(key);
    if (this.attempts.size >= 256) throw new Error('Too many pending OAuth attempts');
    const attempt: OAuthAttempt = { serverId, state, status: 'pending', expiresAt: Date.now() + 10 * 60_000 };
    this.attempts.set(state, attempt);
    return attempt;
  }
  get(serverId: string, state: string): OAuthAttempt | undefined {
    const value = this.attempts.get(state);
    return value?.serverId === serverId && value.expiresAt > Date.now() ? value : undefined;
  }
  cancel(serverId: string, state?: string): void {
    for (const [key, value] of this.attempts) {
      if (value.serverId === serverId && (!state || key === state)) this.attempts.delete(key);
    }
  }
}
