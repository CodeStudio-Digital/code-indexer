import { parseKanbanCardFile } from './company-session-file-codecs.js';
import { nonNegativeSafeInteger } from './company-session-file-values.js';

import { assertUuid, type EntityRecord } from '@mcp/session-storage';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import type { KanbanCard, KanbanCardFull, KanbanColumn, KanbanTag } from '@mcp/company/types.js';
import { CompanySessionFileBase } from './company-session-file-base.js';

export class CompanyKanbanFiles {
  constructor(private readonly context: CompanySessionFileBase) {}

  private nextKanbanSequence: number | null = null;

  private scanKanbanCardsSync(
    includeArchived = false,
  ): Array<{
    record: EntityRecord<Record<string, unknown>>;
    card: KanbanCardFull;
  }> {
    const directory = join(
      this.context.location.bundle_path,
      'company',
      'kanban-cards',
    );
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: Array<{
      record: EntityRecord<Record<string, unknown>>;
      card: KanbanCardFull;
    }> = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are forbidden in Company kanban cards: ${path}`,
        );
      }
      if (
        !entry.isFile() ||
        !/^[0-9a-f-]{36}\.json$/i.test(entry.name)
      ) {
        continue;
      }
      const parsed = parseKanbanCardFile(this.context.companySessionId, path);
      if (includeArchived || parsed.card.archive_id == null) rows.push(parsed);
    }
    rows.sort(
      (left, right) =>
        left.card.position - right.card.position ||
        left.card.seq - right.card.seq ||
        left.card.id.localeCompare(right.card.id),
    );
    return rows;
  }

  private getKanbanEnvelopeSync(
    id: string,
  ): {
    record: EntityRecord<Record<string, unknown>>;
    card: KanbanCardFull;
  } | null {
    const normalized = assertUuid(id, 'Company kanban card id');
    const path = join(
      this.context.location.bundle_path,
      'company',
      'kanban-cards',
      `${normalized}.json`,
    );
    try {
      const parsed = parseKanbanCardFile(this.context.companySessionId, path);
      if (parsed.card.id !== normalized) {
        throw new Error(`Company kanban id/file-name mismatch in ${path}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private projectKanbanBlockers(
    cards: KanbanCardFull[],
  ): KanbanCardFull[] {
    const byId = new Map(cards.map((card) => [card.id, card]));
    return cards.map((card) => ({
      ...card,
      blocked_by: card.dependencies
        .filter((dependency) => {
          const target = byId.get(dependency.depends_on_id);
          return target != null && target.column !== 'done';
        })
        .map((dependency) => dependency.depends_on_id),
    }));
  }

  replaceKanbanCardSync(
    id: string,
    updater: (
      card: KanbanCardFull,
      data: Record<string, unknown>,
      now: string,
    ) => Record<string, unknown>,
  ): KanbanCardFull | null {
    const current = this.getKanbanEnvelopeSync(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const record: EntityRecord<Record<string, unknown>> = {
      ...current.record,
      operationId: randomUUID(),
      updatedAt: now,
      data: updater(current.card, current.record.data, now),
    };
    const directory = this.context.ensureCompanyEntityDirectorySync('kanban-cards');
    this.context.writeCompanyEntityRecordSync(directory, record, false);
    return this.getKanbanCardFullSync(id);
  }

  createKanbanCardSync(input: {
    title: string;
    description?: string;
    column?: KanbanColumn;
    tag?: KanbanTag | null;
    createdBy?: string;
    checklist?: readonly string[];
  }): KanbanCardFull {
    const title = input.title.trim();
    if (!title) throw new TypeError('Company kanban card title is required');
    const existing = this.scanKanbanCardsSync(true);
    const seq =
      this.nextKanbanSequence ??
      existing.reduce((max, row) => Math.max(max, row.card.seq), 0) + 1;
    const position =
      existing
        .filter((row) => row.card.column === (input.column ?? 'backlog'))
        .reduce((max, row) => Math.max(max, row.card.position), -1) + 1;
    const now = new Date().toISOString();
    const id = randomUUID();
    const checklist = (input.checklist ?? []).map((text, index) => ({
      id: randomUUID(),
      text,
      checked: false,
      position: index,
    }));
    const record: EntityRecord<Record<string, unknown>> = {
      schemaVersion: 1,
      id,
      kind: 'company.kanbanCard',
      seq,
      operationId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      relations: {},
      data: {
        title,
        description: input.description ?? '',
        column: input.column ?? 'backlog',
        position,
        tag: input.tag ?? null,
        created_by: input.createdBy ?? 'master',
        archive_id: null,
        checklist,
        comments: [],
        agents: [],
        dependencies: [],
      },
    };
    const directory = this.context.ensureCompanyEntityDirectorySync('kanban-cards');
    this.context.writeCompanyEntityRecordSync(directory, record, true);
    this.nextKanbanSequence = seq + 1;
    return this.getKanbanCardFullSync(id)!;
  }

  listKanbanCardsFullSync(opts?: {
    column?: KanbanColumn;
    includeArchived?: boolean;
  }): KanbanCardFull[] {
    return this.projectKanbanBlockers(
      this.scanKanbanCardsSync(opts?.includeArchived === true)
        .map((row) => row.card),
    ).filter((card) => !opts?.column || card.column === opts.column);
  }

  listKanbanCardsSync(opts?: { column?: KanbanColumn }): KanbanCard[] {
    return this.listKanbanCardsFullSync(opts).map((card) => {
      const {
        checklist: _checklist,
        comments: _comments,
        agents: _agents,
        dependencies: _dependencies,
        blocked_by: _blockedBy,
        ...row
      } = card;
      return row;
    });
  }

  getKanbanCardFullSync(id: string): KanbanCardFull | null {
    const card = this.getKanbanEnvelopeSync(id)?.card ?? null;
    if (!card || card.archive_id != null) return null;
    const all = this.scanKanbanCardsSync().map((row) => row.card);
    return this.projectKanbanBlockers(all)
      .find((candidate) => candidate.id === card.id) ?? null;
  }

  moveKanbanCardSync(
    id: string,
    column: KanbanColumn,
    position?: number,
  ): KanbanCard | null {
    const updated = this.replaceKanbanCardSync(id, (_card, data) => ({
      ...data,
      column,
      ...(position === undefined
        ? {}
        : { position: nonNegativeSafeInteger(position) }),
    }));
    if (!updated) return null;
    const {
      checklist: _checklist,
      comments: _comments,
      agents: _agents,
      dependencies: _dependencies,
      blocked_by: _blockedBy,
      ...card
    } = updated;
    return card;
  }

  updateKanbanCardSync(
    id: string,
    patch: { title?: string; description?: string; tag?: KanbanTag | null },
  ): KanbanCard | null {
    const updated = this.replaceKanbanCardSync(id, (_card, data) => ({
      ...data,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined
        ? {}
        : { description: patch.description }),
      ...(patch.tag === undefined ? {} : { tag: patch.tag }),
    }));
    if (!updated) return null;
    const {
      checklist: _checklist,
      comments: _comments,
      agents: _agents,
      dependencies: _dependencies,
      blocked_by: _blockedBy,
      ...card
    } = updated;
    return card;
  }

  deleteKanbanCardSync(id: string): boolean {
    const current = this.getKanbanEnvelopeSync(id);
    if (!current) return false;
    const dependent = this.listKanbanCardsFullSync().find(
      (candidate) =>
        candidate.id !== current.card.id &&
        candidate.dependencies.some(
          (dependency) => dependency.depends_on_id === current.card.id,
        ),
    );
    if (dependent) {
      throw new Error(
        `Company kanban card ${current.card.id} is still required by ${dependent.id}`,
      );
    }
    const source = join(
      this.context.ensureCompanyEntityDirectorySync('kanban-cards'),
      `${current.card.id}.json`,
    );
    const trash = this.context.ensureCompanyTrashDirectorySync('kanban-cards');
    const target = join(trash, `${current.card.id}.json`);
    if (existsSync(target)) {
      throw new Error(`Company kanban trash entry ${current.card.id} exists`);
    }
    renameSync(source, target);
    this.context.fsyncCompanyDirectoryBestEffortSync(dirname(source));
    this.context.fsyncCompanyDirectoryBestEffortSync(trash);
    return true;
  }
}
