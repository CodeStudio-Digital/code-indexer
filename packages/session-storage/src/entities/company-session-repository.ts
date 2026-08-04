import { randomUUID } from 'node:crypto';
import {
  EntityFileRepository,
  type EntityCreateInput,
  type EntityListOptions,
  type EntityPage,
  type EntityRecord,
  type EntityRelations,
  type EntityTrashResult,
  type EntityUpdateInput,
  assertUuid,
} from './entity-file-repository.js';
import type { JsonValue } from '../types.js';

export type CompanyJsonEntity = {
  [key: string]: unknown;
};

export interface CompanyBoardItemData extends CompanyJsonEntity {
  author_role: string;
  agent_run_id: string | null;
  kind: string;
  content: string;
  mentions: string[];
  archive_id: string | null;
}

export interface CompanyInboxMessageData extends CompanyJsonEntity {
  from_agent_run_id: string;
  from_role: string;
  to_role: string | null;
  to_agent_run_id: string | null;
  kind: string;
  body: string;
  status: string;
  answer: string | null;
  wait_token: string | null;
  delivered_at: string | null;
  answered_at: string | null;
  thread_id: string;
  reply_to_message_id: string | null;
  priority: string;
  context_json: string | null;
}

export interface CompanyKanbanCardData extends CompanyJsonEntity {
  title: string;
  column: string;
}

export interface CompanyAgentData extends CompanyJsonEntity {
  name: string;
  role: string;
  status: string;
}

export interface CompanyAgentRunData extends CompanyJsonEntity {
  status: string;
}

export interface CompanyMasterPromptData extends CompanyJsonEntity {
  kind: string;
  status: string;
}

export interface CompanyQaRunData extends CompanyJsonEntity {
  status: string;
}

export interface CompanyQaResultData extends CompanyJsonEntity {
  run_id: string;
  status: string;
}

export interface CompanyServiceData extends CompanyJsonEntity {
  name: string;
  status: string;
}

export interface CompanySandboxData extends CompanyJsonEntity {
  status: string;
}

export interface CompanyLogData extends CompanyJsonEntity {
  level: string;
  message: string;
}

export interface CompanyAppStudioWorkflowData extends CompanyJsonEntity {
  name: string;
  status: string;
}

export interface CompanyAppStudioRunData extends CompanyJsonEntity {
  status: string;
}

export interface CompanyWorkflowStepData extends CompanyJsonEntity {
  name: string;
  status: string;
}

export interface CompanyDeploymentData extends CompanyJsonEntity {
  status: string;
}

export interface CompanyArchiveData extends CompanyJsonEntity {
  reason?: string | null;
}

/**
 * The encrypted envelope is deliberately provider-neutral. The concrete
 * implementation is expected to use the existing OS keychain-backed cipher.
 */
export interface EncryptedCompanySecret extends CompanyJsonEntity {
  kind: 'encrypted-company-secret';
  version: 1;
  algorithm: string;
  ciphertext: string;
  keyId?: string;
  nonce?: string;
  authTag?: string;
}

export interface CompanyEnvironmentData extends CompanyJsonEntity {
  name: string;
  variables?: Record<string, JsonValue>;
  secrets?: Record<string, EncryptedCompanySecret>;
}

export type CompanySecretInput =
  | string
  | { plaintext: string }
  | EncryptedCompanySecret;

export interface CompanyEnvironmentWriteData extends CompanyJsonEntity {
  name: string;
  variables?: Record<string, JsonValue>;
  secrets?: Record<string, CompanySecretInput>;
}

export interface SecretCipherContext {
  sessionRoot: string;
  entityId: string;
  secretName: string;
  purpose: 'company-session-secret';
}

export interface SecretCipher {
  encrypt(
    plaintext: string,
    context: SecretCipherContext,
  ): Promise<EncryptedCompanySecret>;
}

export interface CompanyEntityDataMap {
  boardItem: CompanyBoardItemData;
  inboxMessage: CompanyInboxMessageData;
  kanbanCard: CompanyKanbanCardData;
  agent: CompanyAgentData;
  agentRun: CompanyAgentRunData;
  masterPrompt: CompanyMasterPromptData;
  qaRun: CompanyQaRunData;
  qaResult: CompanyQaResultData;
  service: CompanyServiceData;
  environment: CompanyEnvironmentData;
  sandbox: CompanySandboxData;
  log: CompanyLogData;
  appStudioWorkflow: CompanyAppStudioWorkflowData;
  appStudioRun: CompanyAppStudioRunData;
  workflowStep: CompanyWorkflowStepData;
  deployment: CompanyDeploymentData;
  archive: CompanyArchiveData;
}

export type CompanyEntityKind = keyof CompanyEntityDataMap;

export type CompanyCreateInput<K extends CompanyEntityKind> =
  EntityCreateInput<CompanyEntityDataMap[K]>;

export type CompanyUpdateInput<K extends CompanyEntityKind> =
  EntityUpdateInput<CompanyEntityDataMap[K]>;

export interface CompanyEnvironmentCreateInput
  extends Omit<EntityCreateInput<CompanyEnvironmentData>, 'data'> {
  data: CompanyEnvironmentWriteData;
}

export interface CompanyEnvironmentUpdateInput
  extends Omit<EntityUpdateInput<CompanyEnvironmentData>, 'data'> {
  data: CompanyEnvironmentWriteData;
}

export interface CompanySessionRepositoryOptions {
  sessionRoot: string;
  secretCipher?: SecretCipher;
  now?: () => Date | string;
  idFactory?: () => string;
}

const COMPANY_ENTITY_DIRECTORIES: Record<CompanyEntityKind, string> = {
  boardItem: 'board-items',
  inboxMessage: 'inbox-messages',
  kanbanCard: 'kanban-cards',
  agent: 'agents',
  agentRun: 'agent-runs',
  masterPrompt: 'master-prompts',
  qaRun: 'qa-runs',
  qaResult: 'qa-results',
  service: 'services',
  environment: 'environments',
  sandbox: 'sandboxes',
  log: 'logs',
  appStudioWorkflow: 'app-studio-workflows',
  appStudioRun: 'app-studio-runs',
  workflowStep: 'workflow-steps',
  deployment: 'deployments',
  archive: 'archives',
};

const IMMUTABLE_COMPANY_ENTITIES = new Set<CompanyEntityKind>(['log']);

function isEncryptedSecret(value: unknown): value is EncryptedCompanySecret {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<EncryptedCompanySecret>;
  const allowedKeys = new Set([
    'kind',
    'version',
    'algorithm',
    'ciphertext',
    'keyId',
    'nonce',
    'authTag',
  ]);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    candidate.kind === 'encrypted-company-secret' &&
    candidate.version === 1 &&
    typeof candidate.algorithm === 'string' &&
    candidate.algorithm.length > 0 &&
    typeof candidate.ciphertext === 'string' &&
    candidate.ciphertext.length > 0 &&
    (
      candidate.keyId == null ||
      (
        typeof candidate.keyId === 'string' &&
        candidate.keyId.length > 0
      )
    ) &&
    (
      candidate.nonce == null ||
      (
        typeof candidate.nonce === 'string' &&
        candidate.nonce.length > 0
      )
    ) &&
    (
      candidate.authTag == null ||
      (
        typeof candidate.authTag === 'string' &&
        candidate.authTag.length > 0
      )
    )
  );
}

function assertEncryptedSecret(
  value: unknown,
  path: string,
): asserts value is EncryptedCompanySecret {
  if (!isEncryptedSecret(value)) {
    throw new Error(
      `Refusing to persist plaintext Company secret at ${path}`,
    );
  }
}

function assertNoPlaintextCompanySecrets(
  value: unknown,
  path = '$',
  insideEncryptedEnvelope = false,
): void {
  if (value == null || typeof value !== 'object') return;
  if (isEncryptedSecret(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPlaintextCompanySecrets(
        item,
        `${path}[${index}]`,
        insideEncryptedEnvelope,
      ),
    );
    return;
  }

  for (const [key, child] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const normalized = key.replaceAll(/[-_]/g, '').toLowerCase();
    if (normalized === 'secrets') {
      if (child == null || typeof child !== 'object' || Array.isArray(child)) {
        throw new Error(
          `Refusing to persist malformed Company secrets at ${path}.${key}`,
        );
      }
      for (const [secretName, secret] of Object.entries(
        child as Record<string, unknown>,
      )) {
        assertEncryptedSecret(secret, `${path}.${key}.${secretName}`);
      }
      continue;
    }
    if (
      !insideEncryptedEnvelope &&
      (
        normalized === 'secret' ||
        normalized === 'password' ||
        normalized === 'token' ||
        normalized === 'apikey' ||
        normalized === 'credential' ||
        normalized === 'privatekey'
      )
    ) {
      assertEncryptedSecret(child, `${path}.${key}`);
      continue;
    }
    assertNoPlaintextCompanySecrets(child, `${path}.${key}`);
  }
}

function validateEncryptedOutput(
  output: EncryptedCompanySecret,
  plaintext: string,
  secretName: string,
): EncryptedCompanySecret {
  assertEncryptedSecret(output, `cipher output for ${secretName}`);
  if (output.ciphertext === plaintext) {
    throw new Error(
      `SecretCipher returned plaintext for Company secret "${secretName}"`,
    );
  }
  if (
    Object.values(output).some(
      (value) => typeof value === 'string' && value === plaintext,
    )
  ) {
    throw new Error(
      `SecretCipher leaked plaintext for Company secret "${secretName}"`,
    );
  }
  return output;
}

/**
 * File-backed Company/App Studio operational state for one session bundle.
 * Reusable Company templates remain outside this repository (and may remain
 * in the essential SQLite catalog).
 */
export class CompanySessionRepository {
  readonly sessionRoot: string;

  private readonly secretCipher?: SecretCipher;
  private readonly now?: () => Date | string;
  private readonly idFactory: () => string;
  private readonly repositories = new Map<
    CompanyEntityKind,
    EntityFileRepository<CompanyJsonEntity>
  >();

  constructor(options: CompanySessionRepositoryOptions) {
    this.sessionRoot = options.sessionRoot;
    this.secretCipher = options.secretCipher;
    this.now = options.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private repository<K extends CompanyEntityKind>(
    kind: K,
  ): EntityFileRepository<CompanyEntityDataMap[K]> {
    let repository = this.repositories.get(kind);
    if (!repository) {
      repository = new EntityFileRepository<CompanyJsonEntity>({
        sessionRoot: this.sessionRoot,
        namespace: `company/${COMPANY_ENTITY_DIRECTORIES[kind]}`,
        kind: `company.${kind}`,
        immutable: IMMUTABLE_COMPANY_ENTITIES.has(kind),
        ...(this.now ? { now: this.now } : {}),
        idFactory: this.idFactory,
      });
      this.repositories.set(kind, repository);
    }
    return repository as EntityFileRepository<CompanyEntityDataMap[K]>;
  }

  private validate<K extends CompanyEntityKind>(
    _kind: K,
    data: CompanyEntityDataMap[K],
  ): void {
    assertNoPlaintextCompanySecrets(data);
  }

  async create<K extends CompanyEntityKind>(
    kind: K,
    input: CompanyCreateInput<K>,
  ): Promise<EntityRecord<CompanyEntityDataMap[K]>> {
    this.validate(kind, input.data);
    return this.repository(kind).create(input);
  }

  async get<K extends CompanyEntityKind>(
    kind: K,
    id: string,
  ): Promise<EntityRecord<CompanyEntityDataMap[K]> | null> {
    return this.repository(kind).get(id);
  }

  async update<K extends CompanyEntityKind>(
    kind: K,
    id: string,
    input: CompanyUpdateInput<K>,
  ): Promise<EntityRecord<CompanyEntityDataMap[K]>> {
    if (input.data) this.validate(kind, input.data);
    return this.repository(kind).update(id, input);
  }

  async list<K extends CompanyEntityKind>(
    kind: K,
    options?: EntityListOptions,
  ): Promise<EntityPage<CompanyEntityDataMap[K]>> {
    return this.repository(kind).list(options);
  }

  async moveToTrash<K extends CompanyEntityKind>(
    kind: K,
    id: string,
  ): Promise<EntityTrashResult<CompanyEntityDataMap[K]>> {
    return this.repository(kind).moveToTrash(id);
  }

  private async protectSecrets(
    entityId: string,
    secrets: Record<string, CompanySecretInput> | undefined,
  ): Promise<Record<string, EncryptedCompanySecret> | undefined> {
    if (!secrets) return undefined;
    const protectedSecrets: Record<string, EncryptedCompanySecret> = {};
    for (const secretName of Object.keys(secrets).sort()) {
      const input = secrets[secretName];
      if (isEncryptedSecret(input)) {
        protectedSecrets[secretName] = input;
        continue;
      }
      const plaintext =
        typeof input === 'string' ? input : input?.plaintext;
      if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new Error(
          `Refusing to persist empty or malformed Company secret "${secretName}"`,
        );
      }
      if (!this.secretCipher) {
        throw new Error(
          `Cannot persist Company secret "${secretName}": SecretCipher is unavailable`,
        );
      }
      let encrypted: EncryptedCompanySecret;
      try {
        encrypted = await this.secretCipher.encrypt(plaintext, {
          sessionRoot: this.sessionRoot,
          entityId,
          secretName,
          purpose: 'company-session-secret',
        });
      } catch (error) {
        throw new Error(
          `Cannot encrypt Company secret "${secretName}"; no data was persisted`,
          { cause: error },
        );
      }
      protectedSecrets[secretName] = validateEncryptedOutput(
        encrypted,
        plaintext,
        secretName,
      );
    }
    return protectedSecrets;
  }

  async createEnvironment(
    input: CompanyEnvironmentCreateInput,
  ): Promise<EntityRecord<CompanyEnvironmentData>> {
    const id = assertUuid(input.id ?? this.idFactory(), 'environment id');
    const protectedSecrets = await this.protectSecrets(id, input.data.secrets);
    const { secrets: _plaintextSecrets, ...environmentData } = input.data;
    const data: CompanyEnvironmentData = {
      ...environmentData,
      ...(protectedSecrets ? { secrets: protectedSecrets } : {}),
    };
    return this.create('environment', { ...input, id, data });
  }

  async updateEnvironment(
    id: string,
    input: CompanyEnvironmentUpdateInput,
  ): Promise<EntityRecord<CompanyEnvironmentData>> {
    const normalized = assertUuid(id, 'environment id');
    const previous = await this.get('environment', normalized);
    if (!previous) throw new Error(`Unknown environment entity ${normalized}`);
    const protectedSecrets = await this.protectSecrets(
      normalized,
      input.data.secrets,
    );
    const { secrets: _plaintextSecrets, ...environmentData } = input.data;
    const data: CompanyEnvironmentData = {
      ...environmentData,
      ...(input.data.secrets !== undefined
        ? { secrets: protectedSecrets ?? {} }
        : previous.data.secrets
          ? { secrets: previous.data.secrets }
          : {}),
    };
    return this.update('environment', normalized, { ...input, data });
  }

  createBoardItem(
    input: EntityCreateInput<CompanyBoardItemData>,
  ): Promise<EntityRecord<CompanyBoardItemData>> {
    return this.create('boardItem', input);
  }

  createInboxMessage(
    input: EntityCreateInput<CompanyInboxMessageData>,
  ): Promise<EntityRecord<CompanyInboxMessageData>> {
    return this.create('inboxMessage', input);
  }

  createKanbanCard(
    input: EntityCreateInput<CompanyKanbanCardData>,
  ): Promise<EntityRecord<CompanyKanbanCardData>> {
    return this.create('kanbanCard', input);
  }

  createAgentRun(
    input: EntityCreateInput<CompanyAgentRunData>,
  ): Promise<EntityRecord<CompanyAgentRunData>> {
    return this.create('agentRun', input);
  }

  createMasterPrompt(
    input: EntityCreateInput<CompanyMasterPromptData>,
  ): Promise<EntityRecord<CompanyMasterPromptData>> {
    return this.create('masterPrompt', input);
  }

  createQaRun(
    input: EntityCreateInput<CompanyQaRunData>,
  ): Promise<EntityRecord<CompanyQaRunData>> {
    return this.create('qaRun', input);
  }

  createQaResult(
    input: EntityCreateInput<CompanyQaResultData>,
  ): Promise<EntityRecord<CompanyQaResultData>> {
    return this.create('qaResult', input);
  }

  createService(
    input: EntityCreateInput<CompanyServiceData>,
  ): Promise<EntityRecord<CompanyServiceData>> {
    return this.create('service', input);
  }

  createAppStudioWorkflow(
    input: EntityCreateInput<CompanyAppStudioWorkflowData>,
  ): Promise<EntityRecord<CompanyAppStudioWorkflowData>> {
    return this.create('appStudioWorkflow', input);
  }

  listByRelation<K extends CompanyEntityKind>(
    kind: K,
    relationName: string,
    relationId: string,
    options: Omit<EntityListOptions, 'relation'> = {},
  ): Promise<EntityPage<CompanyEntityDataMap[K]>> {
    return this.list(kind, {
      ...options,
      relation: { name: relationName, id: relationId },
    });
  }
}

export type { EntityRelations };
