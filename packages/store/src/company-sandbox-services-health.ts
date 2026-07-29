export interface UpdateServiceHealthInput {
  health: string;
  healthDetail?: string | null;
  lastHealthAtMs?: number;
}

export interface CompanySandboxHealthTarget {
  updateHealth(
    sessionId: string,
    serviceId: string,
    input: UpdateServiceHealthInput,
  ): boolean;
  bumpRestartCount(sessionId: string, serviceId: string): number | null;
}

/**
 * Compatibility facade for consumers that keep health operations separate
 * from the sandbox-service store. The target is filesystem-backed; this class
 * owns no database handle and performs no persistence itself.
 */
export class CompanySandboxServicesHealth {
  constructor(private readonly target: CompanySandboxHealthTarget) {}

  updateHealth(
    sessionId: string,
    serviceId: string,
    input: UpdateServiceHealthInput,
  ): boolean {
    return this.target.updateHealth(sessionId, serviceId, input);
  }

  bumpRestartCount(sessionId: string, serviceId: string): number | null {
    return this.target.bumpRestartCount(sessionId, serviceId);
  }
}
