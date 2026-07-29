import {
  EntityFileRepository,
  type EntityCreateInput,
  type EntityPage,
  type EntityRecord,
  type EntityUpdateInput,
} from './entity-file-repository.js';
import type { ArtifactRef } from '../types.js';

export interface DesignVersionData {
  semver: string;
  bumpKind: string;
  isAutoBump: boolean;
  status: string;
  sourceHash: string | null;
  tarballRef: ArtifactRef | null;
  manifestJson: string | null;
  mcpManifestJson: string | null;
  docsMarkdown: string | null;
  storybookPath: string | null;
  error: string | null;
  publishedAt: string | null;
}

export interface DesignComponentData {
  versionId: string;
  name: string;
  componentKind: string;
  propsSchemaJson: string | null;
  exampleCode: string | null;
}

export interface DesignSystemSessionRepositoryOptions {
  sessionRoot: string;
  now?: () => Date | string;
  idFactory?: () => string;
}

async function allRecords<T extends object>(
  repository: EntityFileRepository<T>,
): Promise<EntityRecord<T>[]> {
  const records: EntityRecord<T>[] = [];
  let cursor: string | undefined;
  do {
    const page: EntityPage<T> = await repository.list({
      ...(cursor ? { cursor } : {}),
      limit: 1_000,
      order: 'asc',
    });
    records.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return records;
}

/**
 * Operational Design System records owned by one `kind=design` bundle.
 * Versions and components are independent JSON files so parallel readers do
 * not contend on a shared document.
 */
export class DesignSystemSessionRepository {
  readonly sessionRoot: string;

  private readonly versions: EntityFileRepository<DesignVersionData>;
  private readonly components: EntityFileRepository<DesignComponentData>;

  constructor(options: DesignSystemSessionRepositoryOptions) {
    this.sessionRoot = options.sessionRoot;
    const common = {
      sessionRoot: options.sessionRoot,
      ...(options.now ? { now: options.now } : {}),
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    };
    this.versions = new EntityFileRepository<DesignVersionData>({
      ...common,
      namespace: 'design/versions',
      kind: 'design.version',
    });
    this.components = new EntityFileRepository<DesignComponentData>({
      ...common,
      namespace: 'design/components',
      kind: 'design.component',
    });
  }

  createVersion(
    sessionId: string,
    input: EntityCreateInput<DesignVersionData>,
  ): Promise<EntityRecord<DesignVersionData>> {
    return this.versions.create({
      ...input,
      relations: {
        ...input.relations,
        design_session: sessionId,
      },
    });
  }

  getVersion(id: string): Promise<EntityRecord<DesignVersionData> | null> {
    return this.versions.get(id);
  }

  updateVersion(
    id: string,
    input: EntityUpdateInput<DesignVersionData>,
  ): Promise<EntityRecord<DesignVersionData>> {
    return this.versions.update(id, input);
  }

  listVersions(): Promise<EntityRecord<DesignVersionData>[]> {
    return allRecords(this.versions);
  }

  createComponent(
    input: EntityCreateInput<DesignComponentData>,
  ): Promise<EntityRecord<DesignComponentData>> {
    return this.components.create({
      ...input,
      relations: {
        ...input.relations,
        version: input.data.versionId,
      },
    });
  }

  getComponent(id: string): Promise<EntityRecord<DesignComponentData> | null> {
    return this.components.get(id);
  }

  listComponents(
    versionId?: string,
  ): Promise<EntityRecord<DesignComponentData>[]> {
    if (versionId == null) return allRecords(this.components);
    return this.listComponentsByVersion(versionId);
  }

  private async listComponentsByVersion(
    versionId: string,
  ): Promise<EntityRecord<DesignComponentData>[]> {
    const records: EntityRecord<DesignComponentData>[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.components.list({
        ...(cursor ? { cursor } : {}),
        limit: 1_000,
        order: 'asc',
        relation: { name: 'version', id: versionId },
      });
      records.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return records;
  }
}
