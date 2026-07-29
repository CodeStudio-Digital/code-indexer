import { isAbsolute, posix, win32 } from 'node:path';
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

export type SpriteJsonEntity = {
  [key: string]: unknown;
};

export interface SpriteProductReference extends SpriteJsonEntity {
  path: string;
  sha256: string;
  sizeBytes?: number;
  mediaType?: string;
}

export interface SpriteProjectData extends SpriteJsonEntity {
  name: string;
  status: string;
  style?: JsonValue;
}

export interface SpriteAssetData extends SpriteJsonEntity {
  name: string;
  status: string;
  product?: SpriteProductReference;
  products?: SpriteProductReference[];
}

export interface SpriteVersionData extends SpriteJsonEntity {
  version: number;
  product: SpriteProductReference;
}

export interface SpriteJobData extends SpriteJsonEntity {
  jobType: string;
  status: string;
  products?: SpriteProductReference[];
}

export interface SpriteAnimationData extends SpriteJsonEntity {
  name: string;
  status: string;
  product?: SpriteProductReference;
}

export interface SpriteFrameData extends SpriteJsonEntity {
  frameIndex: number;
  product?: SpriteProductReference;
}

export interface SpriteReferenceData extends SpriteJsonEntity {
  kind: string;
  path: string;
}

export interface SpriteEntityDataMap {
  asset: SpriteAssetData;
  version: SpriteVersionData;
  job: SpriteJobData;
  animation: SpriteAnimationData;
  frame: SpriteFrameData;
  reference: SpriteReferenceData;
}

export type SpriteEntityKind = keyof SpriteEntityDataMap;

export type SpriteCreateInput<K extends SpriteEntityKind> =
  EntityCreateInput<SpriteEntityDataMap[K]>;

export type SpriteUpdateInput<K extends SpriteEntityKind> =
  EntityUpdateInput<SpriteEntityDataMap[K]>;

export interface SpriteSessionRepositoryOptions {
  sessionRoot: string;
  now?: () => Date | string;
  idFactory?: () => string;
}

const SPRITE_ENTITY_DIRECTORIES: Record<SpriteEntityKind, string> = {
  asset: 'assets',
  version: 'versions',
  job: 'jobs',
  animation: 'animations',
  frame: 'frames',
  reference: 'references',
};

const IMMUTABLE_SPRITE_ENTITIES = new Set<SpriteEntityKind>([
  'version',
  'frame',
]);
const SHA256_RE = /^[0-9a-f]{64}$/i;

export function normalizeSpriteProductReference(
  reference: SpriteProductReference,
): SpriteProductReference {
  if (
    !reference ||
    typeof reference !== 'object' ||
    Array.isArray(reference)
  ) {
    throw new TypeError('Sprite product reference must be an object');
  }
  if (
    typeof reference.path !== 'string' ||
    reference.path.length === 0 ||
    reference.path.includes('\0') ||
    isAbsolute(reference.path) ||
    win32.isAbsolute(reference.path) ||
    posix.isAbsolute(reference.path)
  ) {
    throw new TypeError('Sprite product path must be project-relative');
  }
  const normalizedPath = reference.path.replaceAll('\\', '/');
  const segments = normalizedPath.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':'),
    )
  ) {
    throw new TypeError(
      'Sprite product path contains traversal or an unsafe segment',
    );
  }
  if (!SHA256_RE.test(reference.sha256)) {
    throw new TypeError('Sprite product sha256 must contain 64 hex characters');
  }
  if (
    reference.sizeBytes != null &&
    (
      !Number.isSafeInteger(reference.sizeBytes) ||
      reference.sizeBytes < 0
    )
  ) {
    throw new TypeError(
      'Sprite product sizeBytes must be a non-negative safe integer',
    );
  }
  if (
    reference.mediaType != null &&
    (
      typeof reference.mediaType !== 'string' ||
      reference.mediaType.length === 0
    )
  ) {
    throw new TypeError('Sprite product mediaType must be a non-empty string');
  }
  return {
    ...reference,
    path: segments.join('/'),
    sha256: reference.sha256.toLowerCase(),
  };
}

function normalizeProductReferences(
  value: unknown,
  parentKey = '',
): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (parentKey === 'products' || parentKey === 'productRefs') {
      return value.map((item) =>
        normalizeSpriteProductReference(item as SpriteProductReference),
      );
    }
    return value.map((item) => normalizeProductReferences(item));
  }
  if (
    parentKey === 'product' ||
    parentKey === 'productRef' ||
    parentKey === 'outputProduct' ||
    parentKey === 'sourceProduct'
  ) {
    return normalizeSpriteProductReference(
      value as SpriteProductReference,
    );
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(
    value as Record<string, unknown>,
  )) {
    output[key] = normalizeProductReferences(child, key);
  }
  return output;
}

function normalizeEntityData<T extends SpriteJsonEntity>(data: T): T {
  return normalizeProductReferences(data) as T;
}

/**
 * Session-local Sprite Studio state. Product files (PNG, GIF and similar)
 * stay in the owning project; this repository persists only normalized
 * relative paths plus hashes.
 */
export class SpriteSessionRepository {
  readonly sessionRoot: string;

  private readonly options: SpriteSessionRepositoryOptions;
  private readonly projectRepository: EntityFileRepository<SpriteProjectData>;
  private readonly repositories = new Map<
    SpriteEntityKind,
    EntityFileRepository<SpriteJsonEntity>
  >();

  constructor(options: SpriteSessionRepositoryOptions) {
    this.options = options;
    this.sessionRoot = options.sessionRoot;
    this.projectRepository = new EntityFileRepository<SpriteProjectData>({
      sessionRoot: this.sessionRoot,
      namespace: 'sprite',
      kind: 'sprite.project',
      singletonFileName: 'project.json',
      ...(options.now ? { now: options.now } : {}),
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    });
  }

  private repository<K extends SpriteEntityKind>(
    kind: K,
  ): EntityFileRepository<SpriteEntityDataMap[K]> {
    let repository = this.repositories.get(kind);
    if (!repository) {
      repository = new EntityFileRepository<SpriteJsonEntity>({
        sessionRoot: this.sessionRoot,
        namespace: `sprite/${SPRITE_ENTITY_DIRECTORIES[kind]}`,
        kind: `sprite.${kind}`,
        immutable: IMMUTABLE_SPRITE_ENTITIES.has(kind),
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.idFactory
          ? { idFactory: this.options.idFactory }
          : {}),
      });
      this.repositories.set(kind, repository);
    }
    return repository as EntityFileRepository<SpriteEntityDataMap[K]>;
  }

  async createProject(
    input: EntityCreateInput<SpriteProjectData>,
  ): Promise<EntityRecord<SpriteProjectData>> {
    return this.projectRepository.create({
      ...input,
      data: normalizeEntityData(input.data),
    });
  }

  getProject(id: string): Promise<EntityRecord<SpriteProjectData> | null> {
    return this.projectRepository.get(id);
  }

  async updateProject(
    id: string,
    input: EntityUpdateInput<SpriteProjectData>,
  ): Promise<EntityRecord<SpriteProjectData>> {
    return this.projectRepository.update(id, {
      ...input,
      ...(input.data
        ? { data: normalizeEntityData(input.data) }
        : {}),
    });
  }

  moveProjectToTrash(
    id: string,
  ): Promise<EntityTrashResult<SpriteProjectData>> {
    return this.projectRepository.moveToTrash(id);
  }

  async create<K extends SpriteEntityKind>(
    kind: K,
    input: SpriteCreateInput<K>,
  ): Promise<EntityRecord<SpriteEntityDataMap[K]>> {
    return this.repository(kind).create({
      ...input,
      data: normalizeEntityData(input.data),
    });
  }

  get<K extends SpriteEntityKind>(
    kind: K,
    id: string,
  ): Promise<EntityRecord<SpriteEntityDataMap[K]> | null> {
    return this.repository(kind).get(id);
  }

  async update<K extends SpriteEntityKind>(
    kind: K,
    id: string,
    input: SpriteUpdateInput<K>,
  ): Promise<EntityRecord<SpriteEntityDataMap[K]>> {
    return this.repository(kind).update(id, {
      ...input,
      ...(input.data
        ? { data: normalizeEntityData(input.data) }
        : {}),
    });
  }

  list<K extends SpriteEntityKind>(
    kind: K,
    options?: EntityListOptions,
  ): Promise<EntityPage<SpriteEntityDataMap[K]>> {
    return this.repository(kind).list(options);
  }

  moveToTrash<K extends SpriteEntityKind>(
    kind: K,
    id: string,
  ): Promise<EntityTrashResult<SpriteEntityDataMap[K]>> {
    return this.repository(kind).moveToTrash(id);
  }

  createAsset(
    input: EntityCreateInput<SpriteAssetData>,
  ): Promise<EntityRecord<SpriteAssetData>> {
    return this.create('asset', input);
  }

  createVersion(
    input: EntityCreateInput<SpriteVersionData>,
  ): Promise<EntityRecord<SpriteVersionData>> {
    return this.create('version', input);
  }

  createJob(
    input: EntityCreateInput<SpriteJobData>,
  ): Promise<EntityRecord<SpriteJobData>> {
    return this.create('job', input);
  }

  createAnimation(
    input: EntityCreateInput<SpriteAnimationData>,
  ): Promise<EntityRecord<SpriteAnimationData>> {
    return this.create('animation', input);
  }

  createFrame(
    input: EntityCreateInput<SpriteFrameData>,
  ): Promise<EntityRecord<SpriteFrameData>> {
    return this.create('frame', input);
  }

  listByRelation<K extends SpriteEntityKind>(
    kind: K,
    relationName: string,
    relationId: string,
    options: Omit<EntityListOptions, 'relation'> = {},
  ): Promise<EntityPage<SpriteEntityDataMap[K]>> {
    return this.list(kind, {
      ...options,
      relation: { name: relationName, id: relationId },
    });
  }
}
