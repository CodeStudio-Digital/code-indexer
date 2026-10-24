import {
  EntityFileRepository,
  type EntityCreateInput,
  type EntityListOptions,
  type EntityPage,
  type EntityRecord,
  type EntityTrashResult,
  type EntityUpdateInput,
} from './entity-file-repository.js';
import type { JsonValue } from '../types.js';

export type ControlPlaneJsonEntity = {
  [key: string]: unknown;
};

export interface ControlPlaneCommandData extends ControlPlaneJsonEntity {
  commandType: string;
  status: string;
  inputHash?: string;
}

export interface ControlPlaneRunData extends ControlPlaneJsonEntity {
  status: string;
}

export interface ControlPlaneAttemptData extends ControlPlaneJsonEntity {
  ordinal: number;
  status: string;
}

export interface ControlPlaneEventData extends ControlPlaneJsonEntity {
  eventType: string;
  payload?: JsonValue;
}

export interface ControlPlaneGrantData extends ControlPlaneJsonEntity {
  capability: string;
  effect: string;
}

export interface ControlPlanePolicyDecisionData
  extends ControlPlaneJsonEntity {
  effect: string;
  reasonCode: string;
  effectiveInputHash?: string;
}

export interface ControlPlaneCheckpointData extends ControlPlaneJsonEntity {
  checkpointType: string;
}

export interface ControlPlaneApprovalData extends ControlPlaneJsonEntity {
  status: string;
  capability: string;
}

export interface ControlPlaneEntityDataMap {
  command: ControlPlaneCommandData;
  run: ControlPlaneRunData;
  attempt: ControlPlaneAttemptData;
  event: ControlPlaneEventData;
  grant: ControlPlaneGrantData;
  policyDecision: ControlPlanePolicyDecisionData;
  checkpoint: ControlPlaneCheckpointData;
  attemptPreparation: ControlPlaneCheckpointData;
  runtimeRoute: ControlPlaneCheckpointData;
  runtimeRequest: ControlPlaneCheckpointData;
  supervisorFact: ControlPlaneCheckpointData;
  nativePreparation: ControlPlaneCheckpointData;
  nativeActivation: ControlPlaneCheckpointData;
  nativeTree: ControlPlaneCheckpointData;
  approval: ControlPlaneApprovalData;
}

export type ControlPlaneEntityKind = keyof ControlPlaneEntityDataMap;

export type ControlPlaneCreateInput<K extends ControlPlaneEntityKind> =
  EntityCreateInput<ControlPlaneEntityDataMap[K]>;

export type ControlPlaneUpdateInput<K extends ControlPlaneEntityKind> =
  EntityUpdateInput<ControlPlaneEntityDataMap[K]>;

export interface ControlPlaneFileRepositoryOptions {
  sessionRoot: string;
  now?: () => Date | string;
  idFactory?: () => string;
}

const CONTROL_PLANE_DIRECTORIES: Record<ControlPlaneEntityKind, string> = {
  command: 'events/commands',
  run: 'events/runs',
  attempt: 'events/attempts',
  event: 'events/runtime',
  grant: 'events/grants',
  policyDecision: 'events/policy-decisions',
  // `checkpoints/` is owned by the filesystem session store and contains
  // compaction/orchestration envelopes. Control-plane checkpoints use a
  // different envelope schema, so sharing that directory makes either
  // reader reject the other one's records.
  checkpoint: 'checkpoints/control-plane',
  // Main owns admission; worker-owned policy checkpoints keep a separate journal.
  attemptPreparation: 'events/attempt-preparations',
  runtimeRoute: 'events/runtime-routes',
  runtimeRequest: 'events/runtime-requests',
  supervisorFact: 'events/supervisor-facts',
  nativePreparation: 'events/native-preparations',
  nativeActivation: 'events/native-activations',
  nativeTree: 'events/native-trees',
  approval: 'events/approvals',
};

const IMMUTABLE_CONTROL_PLANE_ENTITIES =
  new Set<ControlPlaneEntityKind>([
    'event',
    'policyDecision',
    'checkpoint',
    'attemptPreparation',
    'runtimeRoute',
    'runtimeRequest',
    'supervisorFact',
    'nativePreparation',
    'nativeActivation',
  ]);

/**
 * Session-local command/run/attempt authority. Events, decisions and
 * checkpoints are immutable individual records; their repositories also
 * receive append-only mutation journals for recovery/audit.
 */
export class ControlPlaneFileRepository {
  readonly sessionRoot: string;

  private readonly options: ControlPlaneFileRepositoryOptions;
  private readonly repositories = new Map<
    ControlPlaneEntityKind,
    EntityFileRepository<ControlPlaneJsonEntity>
  >();

  constructor(options: ControlPlaneFileRepositoryOptions) {
    this.options = options;
    this.sessionRoot = options.sessionRoot;
  }

  private repository<K extends ControlPlaneEntityKind>(
    kind: K,
  ): EntityFileRepository<ControlPlaneEntityDataMap[K]> {
    let repository = this.repositories.get(kind);
    if (!repository) {
      repository = new EntityFileRepository<ControlPlaneJsonEntity>({
        sessionRoot: this.sessionRoot,
        namespace: CONTROL_PLANE_DIRECTORIES[kind],
        kind: `control-plane.${kind}`,
        journal: true,
        immutable: IMMUTABLE_CONTROL_PLANE_ENTITIES.has(kind),
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.idFactory
          ? { idFactory: this.options.idFactory }
          : {}),
      });
      this.repositories.set(kind, repository);
    }
    return repository as EntityFileRepository<
      ControlPlaneEntityDataMap[K]
    >;
  }

  create<K extends ControlPlaneEntityKind>(
    kind: K,
    input: ControlPlaneCreateInput<K>,
  ): Promise<EntityRecord<ControlPlaneEntityDataMap[K]>> {
    return this.repository(kind).create(input);
  }

  get<K extends ControlPlaneEntityKind>(
    kind: K,
    id: string,
  ): Promise<EntityRecord<ControlPlaneEntityDataMap[K]> | null> {
    return this.repository(kind).get(id);
  }

  update<K extends ControlPlaneEntityKind>(
    kind: K,
    id: string,
    input: ControlPlaneUpdateInput<K>,
  ): Promise<EntityRecord<ControlPlaneEntityDataMap[K]>> {
    return this.repository(kind).update(id, input);
  }

  list<K extends ControlPlaneEntityKind>(
    kind: K,
    options?: EntityListOptions,
  ): Promise<EntityPage<ControlPlaneEntityDataMap[K]>> {
    return this.repository(kind).list(options);
  }

  moveToTrash<K extends ControlPlaneEntityKind>(
    kind: K,
    id: string,
  ): Promise<EntityTrashResult<ControlPlaneEntityDataMap[K]>> {
    return this.repository(kind).moveToTrash(id);
  }

  createCommand(
    input: EntityCreateInput<ControlPlaneCommandData>,
  ): Promise<EntityRecord<ControlPlaneCommandData>> {
    return this.create('command', input);
  }

  createRun(
    input: EntityCreateInput<ControlPlaneRunData>,
  ): Promise<EntityRecord<ControlPlaneRunData>> {
    return this.create('run', input);
  }

  createAttempt(
    input: EntityCreateInput<ControlPlaneAttemptData>,
  ): Promise<EntityRecord<ControlPlaneAttemptData>> {
    return this.create('attempt', input);
  }

  appendEvent(
    input: EntityCreateInput<ControlPlaneEventData>,
  ): Promise<EntityRecord<ControlPlaneEventData>> {
    return this.create('event', input);
  }

  recordGrant(
    input: EntityCreateInput<ControlPlaneGrantData>,
  ): Promise<EntityRecord<ControlPlaneGrantData>> {
    return this.create('grant', input);
  }

  recordPolicyDecision(
    input: EntityCreateInput<ControlPlanePolicyDecisionData>,
  ): Promise<EntityRecord<ControlPlanePolicyDecisionData>> {
    return this.create('policyDecision', input);
  }

  createCheckpoint(
    input: EntityCreateInput<ControlPlaneCheckpointData>,
  ): Promise<EntityRecord<ControlPlaneCheckpointData>> {
    return this.create('checkpoint', input);
  }

  createApproval(
    input: EntityCreateInput<ControlPlaneApprovalData>,
  ): Promise<EntityRecord<ControlPlaneApprovalData>> {
    return this.create('approval', input);
  }

  listByRelation<K extends ControlPlaneEntityKind>(
    kind: K,
    relationName: string,
    relationId: string,
    options: Omit<EntityListOptions, 'relation'> = {},
  ): Promise<EntityPage<ControlPlaneEntityDataMap[K]>> {
    return this.list(kind, {
      ...options,
      relation: { name: relationName, id: relationId },
    });
  }
}
