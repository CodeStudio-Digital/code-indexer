import type {
  EntityRecord,
  SpriteAnimationData,
  SpriteAssetData,
  SpriteFrameData,
  SpriteJobData,
  SpriteReferenceData,
  SpriteSessionRepository,
  SpriteVersionData,
} from '@mcp/session-storage';
import type {
  SpriteAnimationSettings,
  SpriteAssetStatus,
  SpriteDirection,
  SpriteJobKind,
  SpriteJobStatus,
  SpriteLoopMode,
  SpriteStyleConfig,
  SpriteTrackMeta,
  SpriteVersionSource,
} from '@mcp/store/sprite-studio/types.js';
import type {
  OperationalSessionFiles,
  SpriteProjectFileRow,
} from './operational-session-files.js';

export interface SpriteAssetFileRow {
  id: string;
  sprite_project_id: string;
  slug: string;
  display_name: string;
  category: string;
  tags: string[];
  status: SpriteAssetStatus;
  current_version_id: string | null;
  anchor_reference_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpriteVersionFileRow {
  id: string;
  asset_id: string;
  version: number;
  file_rel_path: string;
  width: number | null;
  height: number | null;
  source: SpriteVersionSource;
  prompt: string | null;
  user_intent: string | null;
  gen_params: Record<string, unknown> | null;
  parent_version_id: string | null;
  job_id: string | null;
  content_hash: string | null;
  created_at: string;
}

export interface SpriteReferenceFileRow {
  id: string;
  sprite_project_id: string;
  asset_id: string | null;
  kind: string;
  file_rel_path: string;
  notes: string | null;
  created_at: string;
}

export interface SpriteAnimationFileRow {
  id: string;
  asset_id: string;
  name: string;
  fps: number;
  loop_mode: SpriteLoopMode;
  status: string;
  settings: SpriteAnimationFileSettings;
  created_at: string;
  updated_at: string;
}

export interface SpriteAnimationFileSettings extends Record<string, unknown> {
  frameCount?: number;
  actionKey?: string;
  direction?: SpriteDirection | string;
  exportName?: string;
  pivot?: { x: number; y: number };
  anchorVersionId?: string;
  lastGenJobId?: string;
  loopStart?: number;
  loopEnd?: number;
  tracks?: SpriteTrackMeta[];
}

export interface SpriteFrameFileRow {
  id: string;
  animation_id: string;
  frame_index: number;
  version_id: string;
  duration_ms: number | null;
  track: number;
}

export interface SpriteJobFileRow {
  id: string;
  sprite_project_id: string;
  asset_id: string | null;
  kind: SpriteJobKind;
  status: SpriteJobStatus;
  user_intent: string | null;
  expanded_prompt: string | null;
  request: Record<string, unknown> | null;
  provider_id: string | null;
  model_id: string | null;
  cost_usd: number | null;
  error: string | null;
  result_version_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export type SpriteProjectRuntimeRow = Omit<SpriteProjectFileRow, 'style'> & {
  style: SpriteStyleConfig;
};

type ProjectContext = {
  project: SpriteProjectRuntimeRow;
  repository: SpriteSessionRepository;
};

function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assetRow(
  projectId: string,
  record: EntityRecord<SpriteAssetData>,
): SpriteAssetFileRow {
  const data = record.data;
  return {
    id: record.id,
    sprite_project_id: projectId,
    slug: String(data.slug ?? ''),
    display_name: String(data.display_name ?? data.name),
    category: String(data.category ?? 'misc'),
    tags: Array.isArray(data.tags)
      ? data.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    status: String(data.status ?? 'draft') as SpriteAssetStatus,
    current_version_id:
      typeof data.current_version_id === 'string'
        ? data.current_version_id
        : null,
    anchor_reference_id:
      typeof data.anchor_reference_id === 'string'
        ? data.anchor_reference_id
        : null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function versionRow(
  record: EntityRecord<SpriteVersionData>,
): SpriteVersionFileRow {
  const data = record.data;
  return {
    id: record.id,
    asset_id: String(data.asset_id),
    version: Number(data.version),
    file_rel_path: String(data.file_rel_path ?? data.product.path),
    width: typeof data.width === 'number' ? data.width : null,
    height: typeof data.height === 'number' ? data.height : null,
    source: String(data.source ?? 'generated') as SpriteVersionSource,
    prompt: typeof data.prompt === 'string' ? data.prompt : null,
    user_intent:
      typeof data.user_intent === 'string' ? data.user_intent : null,
    gen_params:
      data.gen_params != null && typeof data.gen_params === 'object'
        ? data.gen_params as Record<string, unknown>
        : null,
    parent_version_id:
      typeof data.parent_version_id === 'string'
        ? data.parent_version_id
        : null,
    job_id: typeof data.job_id === 'string' ? data.job_id : null,
    content_hash:
      typeof data.content_hash === 'string'
        ? data.content_hash
        : data.product.sha256,
    created_at: record.createdAt,
  };
}

function animationRow(
  record: EntityRecord<SpriteAnimationData>,
): SpriteAnimationFileRow {
  const data = record.data;
  return {
    id: record.id,
    asset_id: String(data.asset_id),
    name: String(data.name),
    fps: Number(data.fps ?? 8),
    loop_mode: String(data.loop_mode ?? 'loop') as SpriteLoopMode,
    status: String(data.status ?? 'draft'),
    settings: clean(
      (data.settings ?? {}) as SpriteAnimationFileSettings,
    ),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function frameRow(record: EntityRecord<SpriteFrameData>): SpriteFrameFileRow {
  const data = record.data;
  return {
    id: record.id,
    animation_id: String(data.animation_id),
    frame_index: Number(data.frame_index ?? data.frameIndex),
    version_id: String(data.version_id),
    duration_ms:
      typeof data.duration_ms === 'number' ? data.duration_ms : null,
    track: typeof data.track === 'number' ? data.track : 0,
  };
}

function jobRow(
  projectId: string,
  record: EntityRecord<SpriteJobData>,
): SpriteJobFileRow {
  const data = record.data;
  return {
    id: record.id,
    sprite_project_id: projectId,
    asset_id: typeof data.asset_id === 'string' ? data.asset_id : null,
    kind: String(data.kind ?? data.jobType) as SpriteJobKind,
    status: String(data.status) as SpriteJobStatus,
    user_intent:
      typeof data.user_intent === 'string' ? data.user_intent : null,
    expanded_prompt:
      typeof data.expanded_prompt === 'string' ? data.expanded_prompt : null,
    request:
      data.request != null && typeof data.request === 'object'
        ? data.request as Record<string, unknown>
        : null,
    provider_id:
      typeof data.provider_id === 'string' ? data.provider_id : null,
    model_id: typeof data.model_id === 'string' ? data.model_id : null,
    cost_usd: typeof data.cost_usd === 'number' ? data.cost_usd : null,
    error: typeof data.error === 'string' ? data.error : null,
    result_version_id:
      typeof data.result_version_id === 'string'
        ? data.result_version_id
        : null,
    started_at:
      typeof data.started_at === 'string' ? data.started_at : null,
    finished_at:
      typeof data.finished_at === 'string' ? data.finished_at : null,
    created_at: record.createdAt,
  };
}

/**
 * Query/mutation facade over per-session Sprite entity files. No method has a
 * database fallback; all records are UUID-addressed and ordered by entity seq.
 */
export class SpriteFileStore {
  readonly #sessions: OperationalSessionFiles;

  constructor(sessions: OperationalSessionFiles) {
    this.#sessions = sessions;
  }

  async projectByIdeId(projectId: number): Promise<SpriteProjectRuntimeRow | null> {
    const row = await this.#sessions.getSpriteProject(projectId);
    return row
      ? { ...row, style: row.style as unknown as SpriteStyleConfig }
      : null;
  }

  async projectById(id: string): Promise<SpriteProjectRuntimeRow | null> {
    const contexts = await this.#sessions.listSpriteProjectContexts();
    const found = contexts.find((context) => context.project.id === id);
    return found
      ? {
          ...found.project,
          style: found.project.style as unknown as SpriteStyleConfig,
        }
      : null;
  }

  async #contextByIdeProject(projectId: number): Promise<ProjectContext | null> {
    const context = await this.#sessions.spriteByProject(projectId);
    return context
      ? {
          ...context,
          project: {
            ...context.project,
            style: context.project.style as unknown as SpriteStyleConfig,
          },
        }
      : null;
  }

  async #contextByProjectId(projectId: string): Promise<ProjectContext | null> {
    const contexts = await this.#sessions.listSpriteProjectContexts();
    const context = contexts.find((item) => item.project.id === projectId);
    return context
      ? {
          ...context,
          project: {
            ...context.project,
            style: context.project.style as unknown as SpriteStyleConfig,
          },
        }
      : null;
  }

  async #assetRecord(id: string) {
    return this.#sessions.findSpriteEntity('asset', id);
  }

  async listAssets(
    spriteProjectId: string,
    filters: {
      category?: string;
      status?: SpriteAssetStatus;
      q?: string;
    } = {},
  ): Promise<SpriteAssetFileRow[]> {
    const context = await this.#contextByProjectId(spriteProjectId);
    if (!context) return [];
    const page = await context.repository.list('asset', {
      limit: 1_000,
      order: 'asc',
    });
    const q = filters.q?.toLowerCase();
    return page.items
      .map((record) => assetRow(spriteProjectId, record))
      .filter((asset) =>
        (!filters.category || asset.category === filters.category) &&
        (!filters.status || asset.status === filters.status) &&
        (!q ||
          asset.slug.toLowerCase().includes(q) ||
          asset.display_name.toLowerCase().includes(q)),
      )
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async getAsset(id: string): Promise<SpriteAssetFileRow | null> {
    const found = await this.#assetRecord(id);
    return found ? assetRow(found.project.id, found.record) : null;
  }

  async createAsset(input: {
    sprite_project_id: string;
    slug: string;
    display_name: string;
    category?: string;
    tags?: string[];
    status?: SpriteAssetStatus;
  }): Promise<SpriteAssetFileRow> {
    const context = await this.#contextByProjectId(input.sprite_project_id);
    if (!context) {
      throw new Error(`Unknown Sprite project ${input.sprite_project_id}`);
    }
    const record = await context.repository.create('asset', {
      relations: { sprite_project_id: input.sprite_project_id },
      data: {
        name: input.display_name,
        slug: input.slug,
        display_name: input.display_name,
        category: input.category ?? 'misc',
        tags: input.tags ?? [],
        status: input.status ?? 'draft',
        current_version_id: null,
        anchor_reference_id: null,
      },
    });
    return assetRow(input.sprite_project_id, record);
  }

  async updateAsset(
    id: string,
    patch: {
      display_name?: string;
      category?: string;
      tags?: string[];
      status?: SpriteAssetStatus;
      anchor_reference_id?: string | null;
    },
  ): Promise<SpriteAssetFileRow | null> {
    const found = await this.#assetRecord(id);
    if (!found) return null;
    const record = await found.repository.update('asset', id, {
      data: clean({
        ...found.record.data,
        ...(patch.display_name === undefined
          ? {}
          : { name: patch.display_name, display_name: patch.display_name }),
        ...(patch.category === undefined ? {} : { category: patch.category }),
        ...(patch.tags === undefined ? {} : { tags: patch.tags }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.anchor_reference_id === undefined
          ? {}
          : { anchor_reference_id: patch.anchor_reference_id }),
      }),
    });
    return assetRow(found.project.id, record);
  }

  async setCurrentVersion(
    assetId: string,
    versionId: string | null,
  ): Promise<boolean> {
    const found = await this.#assetRecord(assetId);
    if (!found) return false;
    await found.repository.update('asset', assetId, {
      data: { ...found.record.data, current_version_id: versionId },
    });
    return true;
  }

  async deleteAsset(id: string): Promise<boolean> {
    const found = await this.#assetRecord(id);
    if (!found) return false;
    const [versions, animations, references, jobs] = await Promise.all([
      found.repository.listByRelation('version', 'asset_id', id, {
        limit: 1_000,
      }),
      found.repository.listByRelation('animation', 'asset_id', id, {
        limit: 1_000,
      }),
      found.repository.listByRelation('reference', 'asset_id', id, {
        limit: 1_000,
      }),
      found.repository.listByRelation('job', 'asset_id', id, {
        limit: 1_000,
      }),
    ]);
    for (const animation of animations.items) {
      await this.deleteAnimation(animation.id);
    }
    for (const version of versions.items) {
      await found.repository.moveToTrash('version', version.id);
    }
    for (const reference of references.items) {
      await found.repository.moveToTrash('reference', reference.id);
    }
    for (const job of jobs.items) {
      await found.repository.update('job', job.id, {
        data: { ...job.data, asset_id: null },
        relations: { sprite_project_id: found.project.id },
      });
    }
    await found.repository.moveToTrash('asset', id);
    return true;
  }

  async listVersions(assetId: string): Promise<SpriteVersionFileRow[]> {
    const asset = await this.#assetRecord(assetId);
    if (!asset) return [];
    const page = await asset.repository.listByRelation(
      'version',
      'asset_id',
      assetId,
      { limit: 1_000 },
    );
    return page.items
      .map(versionRow)
      .sort((left, right) => right.version - left.version);
  }

  async nextVersionNumber(assetId: string): Promise<number> {
    const versions = await this.listVersions(assetId);
    return (versions[0]?.version ?? 0) + 1;
  }

  async insertVersion(input: {
    asset_id: string;
    version?: number;
    file_rel_path: string;
    width?: number | null;
    height?: number | null;
    source: SpriteVersionSource;
    prompt?: string | null;
    user_intent?: string | null;
    gen_params?: Record<string, unknown> | null;
    parent_version_id?: string | null;
    job_id?: string | null;
    content_hash?: string | null;
  }): Promise<SpriteVersionFileRow> {
    const asset = await this.#assetRecord(input.asset_id);
    if (!asset) throw new Error(`Unknown Sprite asset ${input.asset_id}`);
    const version = input.version ?? await this.nextVersionNumber(input.asset_id);
    const hash = input.content_hash;
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error('Sprite version requires a verified content hash');
    }
    const record = await asset.repository.create('version', {
      relations: {
        asset_id: input.asset_id,
        ...(input.job_id ? { job_id: input.job_id } : {}),
      },
      data: clean({
        version,
        asset_id: input.asset_id,
        file_rel_path: input.file_rel_path,
        product: {
          path: input.file_rel_path,
          sha256: hash,
          mediaType: 'image/png',
        },
        width: input.width ?? null,
        height: input.height ?? null,
        source: input.source,
        prompt: input.prompt ?? null,
        user_intent: input.user_intent ?? null,
        gen_params: input.gen_params ?? null,
        parent_version_id: input.parent_version_id ?? null,
        job_id: input.job_id ?? null,
        content_hash: hash.toLowerCase(),
      }),
    });
    return versionRow(record);
  }

  async getVersion(id: string): Promise<SpriteVersionFileRow | null> {
    const found = await this.#sessions.findSpriteEntity('version', id);
    return found ? versionRow(found.record) : null;
  }

  async updateVersionContent(
    id: string,
    input: { width: number; height: number; content_hash: string },
  ): Promise<SpriteVersionFileRow | null> {
    const found = await this.#sessions.findSpriteEntity('version', id);
    if (!found) return null;
    const record = await found.repository.update('version', id, {
      data: {
        ...found.record.data,
        width: input.width,
        height: input.height,
        content_hash: input.content_hash,
        source: 'edited',
        product: {
          ...found.record.data.product,
          sha256: input.content_hash,
        },
      },
    });
    return versionRow(record);
  }

  async deleteVersion(id: string): Promise<boolean> {
    return (await this.deleteVersions([id])).deleted.length > 0;
  }

  async deleteVersions(ids: string[]): Promise<{
    deleted: string[];
    missing: string[];
    framesByAnimation: Record<string, number>;
  }> {
    const deleted: string[] = [];
    const missing: string[] = [];
    const framesByAnimation: Record<string, number> = {};
    const byAsset = new Map<string, Set<string>>();
    for (const id of ids) {
      const found = await this.#sessions.findSpriteEntity('version', id);
      if (!found) {
        missing.push(id);
        continue;
      }
      const frames = await found.repository.listByRelation(
        'frame',
        'version_id',
        id,
        { limit: 1_000 },
      );
      for (const frame of frames.items) {
        const animationId = String(frame.data.animation_id);
        framesByAnimation[animationId] =
          (framesByAnimation[animationId] ?? 0) + 1;
        await found.repository.moveToTrash('frame', frame.id);
      }
      const assetId = String(found.record.data.asset_id);
      let assetVersions = byAsset.get(assetId);
      if (!assetVersions) {
        assetVersions = new Set();
        byAsset.set(assetId, assetVersions);
      }
      assetVersions.add(id);
      await found.repository.moveToTrash('version', id);
      deleted.push(id);
    }
    for (const [assetId, removed] of byAsset) {
      const asset = await this.getAsset(assetId);
      if (asset?.current_version_id && removed.has(asset.current_version_id)) {
        const latest = (await this.listVersions(assetId))[0] ?? null;
        await this.setCurrentVersion(assetId, latest?.id ?? null);
      }
    }
    return { deleted, missing, framesByAnimation };
  }

  async listVersionGroups(assetId: string): Promise<Array<{
    jobId: string | null;
    versionIds: string[];
    createdAt: string;
  }>> {
    const versions = await this.listVersions(assetId);
    const groups = new Map<string, {
      jobId: string | null;
      versions: SpriteVersionFileRow[];
      createdAt: string;
    }>();
    for (const version of versions) {
      const key = version.job_id ?? 'loose';
      const group = groups.get(key) ?? {
        jobId: version.job_id,
        versions: [],
        createdAt: version.created_at,
      };
      group.versions.push(version);
      if (version.created_at > group.createdAt) {
        group.createdAt = version.created_at;
      }
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((group) => ({
        jobId: group.jobId,
        versionIds: group.versions
          .sort((left, right) => left.version - right.version)
          .map((version) => version.id),
        createdAt: group.createdAt,
      }));
  }

  async listReferences(
    spriteProjectId: string,
    assetId?: string | null,
  ): Promise<SpriteReferenceFileRow[]> {
    const context = await this.#contextByProjectId(spriteProjectId);
    if (!context) return [];
    const page =
      assetId == null
        ? await context.repository.list('reference', { limit: 1_000 })
        : await context.repository.listByRelation(
            'reference',
            'asset_id',
            assetId,
            { limit: 1_000 },
          );
    return page.items
      .filter((record) =>
        assetId !== null ||
        record.data.asset_id == null,
      )
      .map((record) => ({
      id: record.id,
      sprite_project_id: spriteProjectId,
      asset_id:
        typeof record.data.asset_id === 'string'
          ? record.data.asset_id
          : null,
      kind: record.data.kind,
      file_rel_path: String(record.data.file_rel_path ?? record.data.path),
      notes:
        typeof record.data.notes === 'string' ? record.data.notes : null,
      created_at: record.createdAt,
      }));
  }

  async insertReference(input: {
    sprite_project_id: string;
    asset_id?: string | null;
    kind: string;
    file_rel_path: string;
    notes?: string | null;
  }): Promise<SpriteReferenceFileRow> {
    const context = await this.#contextByProjectId(input.sprite_project_id);
    if (!context) {
      throw new Error(`Unknown Sprite project ${input.sprite_project_id}`);
    }
    const record = await context.repository.create('reference', {
      relations: {
        sprite_project_id: input.sprite_project_id,
        ...(input.asset_id ? { asset_id: input.asset_id } : {}),
      },
      data: {
        kind: input.kind,
        path: input.file_rel_path,
        file_rel_path: input.file_rel_path,
        asset_id: input.asset_id ?? null,
        notes: input.notes ?? null,
      },
    });
    return {
      id: record.id,
      sprite_project_id: input.sprite_project_id,
      asset_id: input.asset_id ?? null,
      kind: input.kind,
      file_rel_path: input.file_rel_path,
      notes: input.notes ?? null,
      created_at: record.createdAt,
    };
  }

  async deleteReference(id: string): Promise<boolean> {
    const found = await this.#sessions.findSpriteEntity('reference', id);
    if (!found) return false;
    await found.repository.moveToTrash('reference', id);
    return true;
  }

  async listAnimations(assetId: string): Promise<SpriteAnimationFileRow[]> {
    const asset = await this.#assetRecord(assetId);
    if (!asset) return [];
    const page = await asset.repository.listByRelation(
      'animation',
      'asset_id',
      assetId,
      { limit: 1_000 },
    );
    return page.items.map(animationRow);
  }

  async getAnimation(id: string): Promise<SpriteAnimationFileRow | null> {
    const found = await this.#sessions.findSpriteEntity('animation', id);
    return found ? animationRow(found.record) : null;
  }

  async createAnimation(input: {
    asset_id: string;
    name: string;
    fps?: number;
    loop_mode?: SpriteLoopMode;
    status?: string;
    settings?: SpriteAnimationFileSettings;
  }): Promise<SpriteAnimationFileRow> {
    const asset = await this.#assetRecord(input.asset_id);
    if (!asset) throw new Error(`Unknown Sprite asset ${input.asset_id}`);
    const existing = await this.listAnimations(input.asset_id);
    if (existing.some((animation) => animation.name === input.name)) {
      throw new Error(`Animation name "${input.name}" is already used`);
    }
    const record = await asset.repository.create('animation', {
      relations: { asset_id: input.asset_id },
      data: clean({
        name: input.name,
        asset_id: input.asset_id,
        fps: input.fps ?? 8,
        loop_mode: input.loop_mode ?? 'loop',
        status: input.status ?? 'draft',
        settings: input.settings ?? {},
      }),
    });
    return animationRow(record);
  }

  async updateAnimation(
    id: string,
    patch: {
      name?: string;
      fps?: number;
      loop_mode?: SpriteLoopMode;
      status?: string;
      settings?: SpriteAnimationFileSettings;
    },
  ): Promise<SpriteAnimationFileRow | null> {
    const found = await this.#sessions.findSpriteEntity('animation', id);
    if (!found) return null;
    const record = await found.repository.update('animation', id, {
      data: clean({
        ...found.record.data,
        ...patch,
      }),
    });
    return animationRow(record);
  }

  async mergeAnimationSettings(
    id: string,
    patch: Partial<SpriteAnimationFileSettings>,
  ): Promise<SpriteAnimationFileRow | null> {
    const current = await this.getAnimation(id);
    return current
      ? this.updateAnimation(id, {
          settings: clean({ ...current.settings, ...patch }),
        })
      : null;
  }

  async deleteAnimation(id: string): Promise<boolean> {
    const found = await this.#sessions.findSpriteEntity('animation', id);
    if (!found) return false;
    const frames = await found.repository.listByRelation(
      'frame',
      'animation_id',
      id,
      { limit: 1_000 },
    );
    for (const frame of frames.items) {
      await found.repository.moveToTrash('frame', frame.id);
    }
    await found.repository.moveToTrash('animation', id);
    return true;
  }

  async listFrames(
    animationId: string,
    track?: number,
  ): Promise<SpriteFrameFileRow[]> {
    const animation = await this.#sessions.findSpriteEntity(
      'animation',
      animationId,
    );
    if (!animation) return [];
    const page = await animation.repository.listByRelation(
      'frame',
      'animation_id',
      animationId,
      { limit: 1_000 },
    );
    return page.items
      .map(frameRow)
      .filter((frame) => track === undefined || frame.track === track)
      .sort((left, right) =>
        left.track - right.track || left.frame_index - right.frame_index,
      );
  }

  async replaceTrackFrames(
    animationId: string,
    track: number,
    frames: Array<{
      frame_index: number;
      version_id: string;
      duration_ms?: number | null;
    }>,
  ): Promise<SpriteFrameFileRow[]> {
    const found = await this.#sessions.findSpriteEntity(
      'animation',
      animationId,
    );
    if (!found) throw new Error(`Unknown Sprite animation ${animationId}`);
    const existing = await this.listFrames(animationId, track);
    for (const frame of existing) {
      await found.repository.moveToTrash('frame', frame.id);
    }
    const created: SpriteFrameFileRow[] = [];
    for (const input of frames) {
      const version = await this.getVersion(input.version_id);
      if (!version) {
        throw new Error(`Unknown Sprite version ${input.version_id}`);
      }
      const record = await found.repository.create('frame', {
        relations: {
          animation_id: animationId,
          version_id: input.version_id,
        },
        data: {
          frameIndex: input.frame_index,
          frame_index: input.frame_index,
          animation_id: animationId,
          version_id: input.version_id,
          duration_ms: input.duration_ms ?? null,
          track,
        },
      });
      created.push(frameRow(record));
    }
    return created;
  }

  replaceFrames(
    animationId: string,
    frames: Array<{
      frame_index: number;
      version_id: string;
      duration_ms?: number | null;
    }>,
  ): Promise<SpriteFrameFileRow[]> {
    return this.replaceTrackFrames(animationId, 0, frames);
  }

  async deleteTrackFrames(animationId: string, track: number): Promise<void> {
    const found = await this.#sessions.findSpriteEntity(
      'animation',
      animationId,
    );
    if (!found) return;
    for (const frame of await this.listFrames(animationId, track)) {
      await found.repository.moveToTrash('frame', frame.id);
    }
  }

  async insertJob(input: {
    sprite_project_id: string;
    asset_id?: string | null;
    kind: SpriteJobKind;
    user_intent?: string | null;
    request?: Record<string, unknown> | null;
  }): Promise<SpriteJobFileRow> {
    const context = await this.#contextByProjectId(input.sprite_project_id);
    if (!context) {
      throw new Error(`Unknown Sprite project ${input.sprite_project_id}`);
    }
    const record = await context.repository.create('job', {
      relations: {
        sprite_project_id: input.sprite_project_id,
        ...(input.asset_id ? { asset_id: input.asset_id } : {}),
      },
      data: clean({
        jobType: input.kind,
        kind: input.kind,
        status: 'queued',
        asset_id: input.asset_id ?? null,
        user_intent: input.user_intent ?? null,
        expanded_prompt: null,
        request: input.request ?? null,
        provider_id: null,
        model_id: null,
        cost_usd: null,
        error: null,
        result_version_id: null,
        started_at: null,
        finished_at: null,
      }),
    });
    return jobRow(input.sprite_project_id, record);
  }

  async getJob(id: string): Promise<SpriteJobFileRow | null> {
    const found = await this.#sessions.findSpriteEntity('job', id);
    return found ? jobRow(found.project.id, found.record) : null;
  }

  async listJobs(
    spriteProjectId: string,
    limit = 100,
  ): Promise<SpriteJobFileRow[]> {
    const context = await this.#contextByProjectId(spriteProjectId);
    if (!context) return [];
    const page = await context.repository.list('job', {
      limit: Math.max(1, Math.min(1_000, limit)),
      order: 'desc',
    });
    return page.items.map((record) => jobRow(spriteProjectId, record));
  }

  async #updateJob(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<SpriteJobFileRow | null> {
    const found = await this.#sessions.findSpriteEntity('job', id);
    if (!found) return null;
    const record = await found.repository.update('job', id, {
      data: clean({ ...found.record.data, ...patch }),
    });
    return jobRow(found.project.id, record);
  }

  updateJobStatus(id: string, status: SpriteJobStatus) {
    const now = new Date().toISOString();
    return this.#updateJob(id, {
      status,
      ...(['prompting', 'generating', 'postprocess', 'saving'].includes(status)
        ? { started_at: now }
        : {}),
      ...(['done', 'failed', 'cancelled'].includes(status)
        ? { finished_at: now }
        : {}),
    });
  }

  setJobResult(
    id: string,
    patch: Partial<Pick<
      SpriteJobFileRow,
      | 'expanded_prompt'
      | 'provider_id'
      | 'model_id'
      | 'cost_usd'
      | 'result_version_id'
    >>,
  ) {
    return this.#updateJob(id, patch);
  }

  setJobError(id: string, error: string) {
    return this.#updateJob(id, {
      status: 'failed',
      error,
      finished_at: new Date().toISOString(),
    });
  }

  async hasJob(id: string): Promise<boolean> {
    return (await this.getJob(id)) != null;
  }

  async resolveAnimation(id: string): Promise<{
    anim: SpriteAnimationFileRow;
    asset: SpriteAssetFileRow;
    spriteProject: SpriteProjectRuntimeRow;
    root: string | null;
  } | null> {
    const anim = await this.getAnimation(id);
    if (!anim) return null;
    const asset = await this.getAsset(anim.asset_id);
    if (!asset) return null;
    const spriteProject = await this.projectById(asset.sprite_project_id);
    if (!spriteProject) return null;
    return {
      anim,
      asset,
      spriteProject,
      root: spriteProject.root_path || null,
    };
  }
}

export type {
  SpriteAnimationSettings,
  SpriteDirection,
  SpriteTrackMeta,
};
