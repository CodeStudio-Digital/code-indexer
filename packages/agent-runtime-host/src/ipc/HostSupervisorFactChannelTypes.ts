import type {
  SupervisorFactBinding,
  SupervisorLifecycleFact,
  SupervisorLifecycleFactCase,
} from '../driver/HostSupervisorFactTypes.js';

export interface PendingSupervisorFact {
  readonly fact: SupervisorLifecycleFact;
  readonly binding: SupervisorFactBinding;
  readonly headerSentAtUnixMs: bigint;
  readonly envelopeDigest: string;
  readonly token: object;
}

export type SupervisorFactReceiveOutcome =
  | { readonly kind: 'pending'; readonly pending: PendingSupervisorFact }
  | {
    readonly kind: 'replayed';
    readonly factCase: SupervisorLifecycleFactCase;
    readonly messageId: string;
  };
