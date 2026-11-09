
import { object, nullableString, stringValue, companyMetadata } from './company-session-file-values.js';
import type { CompanySessionFileSnapshot } from './company-session-file-types.js';
import { CompanySessionRepository, asCompanySessionId, asSessionId, type CompanySessionId, type EntityRecord, type SessionId, type SessionLocation, type SessionMetadata } from '@mcp/session-storage';
import { accessSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { companySessionIdentity } from './session-identity.js';

export class CompanySessionFileBase {
  readonly companySessionId: CompanySessionId;
  readonly location: SessionLocation;
  readonly entities: CompanySessionRepository;

  readonly sessionStore: FsSessionStore;

  constructor(input: {
    companySessionId: CompanySessionId | string;
    sessionStore: FsSessionStore;
  }) {
    this.companySessionId = asCompanySessionId(String(input.companySessionId));
    this.sessionStore = input.sessionStore;
    const entry = input.sessionStore.catalog.get(
      asSessionId(this.companySessionId),
    );
    if (!entry) {
      throw new Error(
        `Unknown filesystem Company session ${this.companySessionId}; catalog must be primed before wiring`,
      );
    }
    if (
      entry.session.kind !== 'company' &&
      entry.session.kind !== 'app_studio'
    ) {
      throw new Error(
        `Session ${this.companySessionId} is ${entry.session.kind}, not Company/App Studio`,
      );
    }
    this.location = entry.location;
    this.entities = new CompanySessionRepository({
      sessionRoot: entry.location.bundle_path,
    });
  }

  getSession(): CompanySessionFileSnapshot {
    const session = this.sessionStore.repository.readSessionSync(this.location);
    const state = this.sessionStore.repository.readStateSync(this.location);
    const metadata = companyMetadata(session);
    const labels = object(metadata.project_labels);
    return {
      ...companySessionIdentity({ id: this.companySessionId, parent_session_id: session.parent_session_id, config_json: stringValue(metadata.config_json, '{}') }, metadata.configuration_origin),
      id: this.companySessionId,
      template_id:
        typeof metadata.template_id === 'number'
          ? metadata.template_id
          : null,
      runtime_kind:
        metadata.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
      name: stringValue(metadata.name, session.title ?? 'Company'),
      status: state.status,
      master_session_id:
        typeof metadata.master_session_id === 'string'
          ? asSessionId(metadata.master_session_id)
          : null,
      config_json: stringValue(metadata.config_json, '{}'),
      parent_session_id:
        session.parent_session_id == null
          ? null
          : asCompanySessionId(session.parent_session_id),
      archived_at: state.archived_at,
      recovered_at: nullableString(metadata.recovered_at),
      recovered_reason: nullableString(metadata.recovered_reason),
      project_ids: session.linked_projects.map((project) => project.project_id),
      project_labels: Object.fromEntries(
        Object.entries(labels).map(([projectId, label]) => [
          projectId,
          typeof label === 'string' ? label : null,
        ]),
      ),
      created_at: session.created_at,
      updated_at:
        Date.parse(state.updated_at) > Date.parse(session.updated_at)
          ? state.updated_at
          : session.updated_at,
    };
  }

  async setMasterSessionId(id: SessionId | string | null): Promise<void> {
    const normalized = id == null ? null : asSessionId(String(id));
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => ({
            ...session,
            metadata: {
              ...session.metadata,
              company: {
                ...companyMetadata(session),
                master_session_id: normalized,
              },
            },
          }) as SessionMetadata,
        );
      },
    );
  }

  async updateSessionStatus(status: string): Promise<void> {
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateState(
          this.location,
          (state) => ({ ...state, status }),
        );
      },
    );
  }

  async updateSessionConfig(configJson: string, configurationOrigin?: { revision: string; inherited_from: string }): Promise<void> {
    const parsed: unknown = JSON.parse(configJson);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Company session config must be a JSON object');
    }
    const normalized = JSON.stringify(parsed);
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => ({
            ...session,
            metadata: {
              ...session.metadata,
              company: {
                ...companyMetadata(session),
                config_json: normalized,
                ...(configurationOrigin ? { configuration_origin: configurationOrigin } : {}),
              },
            },
          }) as SessionMetadata,
        );
      },
    );
  }

  async addLinkedProject(input: {
    projectId: number;
    rootPath: string;
    label?: string | null;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.projectId) || input.projectId < 1) {
      throw new TypeError('projectId must be a positive integer');
    }
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => {
            if (
              session.linked_projects.some(
                (project) => project.project_id === input.projectId,
              )
            ) {
              throw new TypeError(
                `Project ${input.projectId} is already linked to Company session ${this.companySessionId}`,
              );
            }
            const metadata = companyMetadata(session);
            const labels = object(metadata.project_labels);
            return {
              ...session,
              linked_projects: [
                ...session.linked_projects,
                {
                  project_id: input.projectId,
                  root_path: input.rootPath,
                },
              ],
              metadata: {
                ...session.metadata,
                company: {
                  ...metadata,
                  project_labels: {
                    ...labels,
                    [String(input.projectId)]: input.label ?? null,
                  },
                },
              },
            } as SessionMetadata;
          },
        );
      },
    );
  }

  async removeLinkedProject(projectId: number): Promise<void> {
    if (!Number.isSafeInteger(projectId) || projectId < 1) {
      throw new TypeError('projectId must be a positive integer');
    }
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => {
            if (session.owner_project_id === projectId) {
              throw new TypeError('The owning Company project cannot be unlinked');
            }
            if (
              !session.linked_projects.some(
                (project) => project.project_id === projectId,
              )
            ) {
              throw new TypeError(
                `Project ${projectId} is not linked to Company session ${this.companySessionId}`,
              );
            }
            const metadata = companyMetadata(session);
            const labels = { ...object(metadata.project_labels) };
            delete labels[String(projectId)];
            return {
              ...session,
              linked_projects: session.linked_projects.filter(
                (project) => project.project_id !== projectId,
              ),
              metadata: {
                ...session.metadata,
                company: {
                  ...metadata,
                  project_labels: labels,
                },
              },
            } as SessionMetadata;
          },
        );
      },
    );
  }

  async clearRecoveryFlag(): Promise<void> {
    await this.sessionStore.runSessionMutation(
      asSessionId(this.companySessionId),
      async () => {
        await this.sessionStore.repository.updateSession(
          this.location,
          (session) => ({
            ...session,
            metadata: {
              ...session.metadata,
              company: {
                ...companyMetadata(session),
                recovered_at: null,
                recovered_reason: null,
              },
            },
          }) as SessionMetadata,
        );
      },
    );
  }

  ensureCompanyEntityDirectorySync(
    directoryName: 'board-items' | 'inbox-messages' | 'kanban-cards',
  ): string {
    let current = this.location.bundle_path;
    const rootStat = lstatSync(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Unsafe Company session bundle ${current}`);
    }
    for (const segment of ['company', directoryName]) {
      current = join(current, segment);
      try {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Unsafe Company entity directory ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(current, { mode: 0o700 });
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Unsafe Company entity directory ${current}`);
        }
      }
    }
    accessSync(current, constants.R_OK | constants.W_OK);
    return current;
  }

  ensureCompanyTrashDirectorySync(
    directoryName: 'kanban-cards',
  ): string {
    let current = this.location.bundle_path;
    const rootStat = lstatSync(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Unsafe Company session bundle ${current}`);
    }
    for (const segment of ['company', 'trash', directoryName]) {
      current = join(current, segment);
      try {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Unsafe Company trash directory ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(current, { mode: 0o700 });
      }
    }
    accessSync(current, constants.R_OK | constants.W_OK);
    return current;
  }

  fsyncCompanyDirectoryBestEffortSync(directory: string): void {
    try {
      const handle = openSync(directory, 'r');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== 'EISDIR' &&
        code !== 'EINVAL' &&
        code !== 'ENOTSUP' &&
        code !== 'EPERM' &&
        code !== 'EACCES'
      ) {
        throw error;
      }
    }
  }

  writeCompanyEntityRecordSync(
    directory: string,
    record: EntityRecord<Record<string, unknown>>,
    createOnly: boolean,
  ): void {
    const target = join(directory, `${record.id}.json`);
    if (createOnly && existsSync(target)) {
      throw new Error(`Company entity ${record.id} already exists`);
    }
    if (!createOnly && !existsSync(target)) {
      throw new Error(`Company entity ${record.id} does not exist`);
    }
    const temp = join(
      directory,
      `.${record.id}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: number | null = null;
    try {
      handle = openSync(temp, 'wx', 0o600);
      writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fsyncSync(handle);
      closeSync(handle);
      handle = null;
      if (createOnly) {
        // Publish-if-absent across workers. An exists-check followed by rename
        // can overwrite a concurrently delivered inbox row with pending state.
        linkSync(temp, target);
        unlinkSync(temp);
      } else renameSync(temp, target);
      this.fsyncCompanyDirectoryBestEffortSync(directory);
    } catch (error) {
      if (handle != null) {
        try {
          closeSync(handle);
        } catch {
          // Preserve the original write failure.
        }
      }
      try {
        unlinkSync(temp);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new AggregateError(
            [error, cleanupError],
            `Failed to persist and clean up Company entity ${record.id}`,
          );
        }
      }
      throw error;
    }
  }
}
