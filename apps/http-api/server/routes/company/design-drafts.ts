import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { asCompanySessionId } from '@mcp/session-storage';
import { publishCompanyPanelChange } from '../../../sse/notification-event-bus.js';
import { CollaborationFiles } from '@mcp/session-storage/collaboration/files.js';
import { CollaborationRevisions } from '@mcp/session-storage/collaboration/revisions.js';
import { CompanyKanbanFiles } from '@mcp/company/services/company-kanban-files.js';
import { CompanyKanbanRelations } from '@mcp/company/services/company-kanban-relations.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { companyConfigRevision } from '@mcp/company/services/session-identity.js';
import {
  blankPlan,
  designPlan,
  designPin,
  newRole,
  type DesignDraft,
} from '@mcp/company-contracts/designer.js';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { HttpContext } from '@mcp/shared/http/context.js';
import type { ServerDeps } from '../../deps.js';
import { withSessionLock } from '../coder/sessionLock.js';
import { checkModel, companyDesignConfig, fromCompany, validateDesign } from './design-catalog.js';
import { generateDesign } from './design-proposal.js';

const uuid = z.string().uuid();
const rev = z.number().int().positive();
const advisor = z.object({ provider: z.string().max(160), model: z.string().max(250) });
const patchBody = z.object({
  expectedRevision: rev,
  advisor: advisor.optional(),
  changes: designPlan.partial().strict(),
  pins: z.array(designPin).max(600).optional(),
  turn: z.object({ request: z.string().max(12000), reply: z.string().max(6000) }).optional(),
});
const meta = (draft: DesignDraft) => ({
  id: draft.id,
  name: draft.plan.name,
  sourceId: draft.source?.id ?? null,
  done: !!draft.apply?.done,
});
function failure(c: HttpContext, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return c.json(
    { error: message },
    message === 'revision_conflict' || message.includes('mudou')
      ? 409
      : message === 'Rascunho inexistente.'
        ? 404
        : 400,
  );
}
export function mountDesignRoutes(app: HttpRouter, deps: ServerDeps, generate = generateDesign) {
  // Initialized lazily so mounting minimal Company hosts never opens a data directory.
  let store: CollaborationRevisions | undefined;
  function storage() {
    return (store ??= new CollaborationRevisions(
      new CollaborationFiles(join(dirname(deps.config.dbPath), 'company-drafts')),
    ));
  }
  const load = async (id: string) => {
    const row = await storage().read<DesignDraft>('drafts', uuid.parse(id));
    if (!row) throw new Error('Rascunho inexistente.');
    return { ...row.value, revision: row.revision };
  };
  async function write(draft: DesignDraft, expected: number) {
    const repo = storage();
    await Promise.all([repo.files.ensure('drafts'), repo.files.ensure('catalog')]);
    const row = await repo.change(
      'drafts',
      draft.id,
      draft,
      () => ({ ...draft, revision: expected + 1 }),
      expected,
    );
    await repo.files.put('catalog', draft.id, meta(row.value));
    return row.value;
  }
  const path = '/api/company/drafts';
  app.get(path, async (c) => {
    const files = storage().files;
    await files.ensure('catalog');
    return c.json((await files.list<ReturnType<typeof meta>>('catalog')).filter((item) => !item.done));
  });
  app.post(path, async (c) => {
    try {
      const input = z
        .object({
          sourceId: uuid.optional(),
          provider: z.string().default(''),
          model: z.string().default(''),
        })
        .parse(await c.req.json());
      let source: DesignDraft['source'] = null;
      let plan = blankPlan();
      if (input.sourceId) {
        const company = await deps.operationalSessionFiles.getCompanySession(input.sourceId);
        if (!company || company.parent_session_id || company.runtime_kind !== 'company')
          throw new Error('Selecione a empresa raiz.');
        const projects = deps.sessionStore.catalog.get(input.sourceId)!.session.linked_projects;
        source = { id: input.sourceId, configRevision: companyConfigRevision(company.config_json) };
        plan = fromCompany(
          company.name,
          projects.map((p) => p.project_id),
          JSON.parse(company.config_json),
        );
      } else {
        if (input.provider) checkModel(deps, input.provider, input.model);
        plan.roles = [newRole('master', input.provider, input.model)];
      }
      return c.json(
        await write(
          {
            id: randomUUID(),
            revision: 0,
            schemaVersion: 1,
            advisor: { provider: input.provider, model: input.model },
            plan,
            pins: [],
            history: [],
            source,
            apply: null,
          },
          0,
        ),
        201,
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post(path + '/skills', async (c) => {
    try {
      const { projectIds, query } = z
        .object({
          projectIds: z.array(z.number().int().positive()).max(50),
          query: z.string().max(200).default(''),
        })
        .parse(await c.req.json());
      const scopes = ['global', ...projectIds.filter((id) => deps.db.getProject(id)).map(String)];
      return c.json(
        deps.skillStore.listComposerSkills(scopes, query, false).map((s) => ({ id: s.id, name: s.name })),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get(path + '/:id', async (c) => {
    try {
      return c.json(await load(c.req.param('id')));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.patch(path + '/:id', async (c) => {
    try {
      const input = patchBody.parse(await c.req.json());
      const draft = await load(c.req.param('id'));
      if (draft.revision !== input.expectedRevision || draft.apply)
        return c.json({ error: 'O rascunho mudou.', revision: draft.revision }, 409);
      return c.json(
        await write(
          {
            ...draft,
            plan: { ...draft.plan, ...input.changes },
            advisor: input.advisor ?? draft.advisor,
            pins: input.pins ?? draft.pins,
            history: input.turn ? [...draft.history, input.turn].slice(-12) : draft.history,
          },
          draft.revision,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post(path + '/:id/proposals', async (c) => {
    try {
      const input = z
        .object({
          expectedRevision: rev,
          request: z.string().trim().min(1).max(12000),
          provider: z.string().min(1),
          model: z.string().min(1),
        })
        .parse(await c.req.json());
      const draft = await load(c.req.param('id'));
      if (draft.apply || draft.revision !== input.expectedRevision)
        return c.json({ error: 'O rascunho mudou.', revision: draft.revision }, 409);
      const proposal = await generate(
        deps,
        draft,
        input.request,
        input.provider,
        input.model,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120000)]),
      );
      return c.json(proposal);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post(path + '/:id/template', async (c) => {
    try {
      const draft = await load(c.req.param('id'));
      if (!draft.apply?.done) return c.json({ error: 'Aplique a empresa antes de salvar o template.' }, 409);
      const config = companyDesignConfig(draft.plan);
      const roles = config.role_assignments.map(({ projectIds, ...role }) => ({
        ...role,
        projectHints: (projectIds ?? []).map((id) => deps.db.getProject(id)?.name ?? String(id)),
      }));
      return c.json(
        deps.companyStore.createTemplateForDraft(draft.id, draft.plan.name, draft.plan.goal, roles),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post(path + '/:id/apply', async (c) => {
    try {
      const { expectedRevision, key } = z
        .object({ expectedRevision: rev, key: uuid })
        .parse(await c.req.json());
      const id = uuid.parse(c.req.param('id'));
      return await withSessionLock('design:' + id, async () => {
        let draft = await load(id);
        if (draft.apply && draft.apply.key !== key)
          return c.json(
            { error: 'Outro pedido de aplicação já está registrado.', revision: draft.revision },
            409,
          );
        if (draft.apply?.done) return c.json(draft);
        if (!draft.apply && draft.revision !== expectedRevision)
          return c.json({ error: 'O rascunho mudou.', revision: draft.revision }, 409);
        const plan = draft.plan;
        validateDesign(deps, plan);
        const companyId = draft.apply?.companyId ?? draft.source?.id ?? randomUUID();
        const sessions = deps.operationalSessionFiles;
        return withSessionLock(companyId, async () => {
          let root = await sessions.getCompanySession(companyId);
          const previous = JSON.parse(root?.config_json ?? '{}');
          if (draft.source && (!root || root.parent_session_id || root.runtime_kind !== 'company'))
            throw new Error('Empresa raiz indisponível.');
          if (
            draft.source &&
            previous.design_applied !== id &&
            companyConfigRevision(root!.config_json) !== draft.source.configRevision
          ) {
            throw new Error('A configuração da empresa mudou. Reabra a configuração antes de aplicar.');
          }
          if (
            draft.source &&
            previous.design_applied !== id &&
            (root?.status === 'running' || root?.status === 'paused')
          ) {
            throw new Error(
              'Encerre a execução da sessão principal para aplicar. As sessões filhas em execução conservam sua revisão.',
            );
          }
          if (draft.source) {
            const owner = deps.sessionStore.catalog.get(companyId)?.session.owner_project_id;
            if (owner != null && !plan.projectIds.includes(owner))
              throw new Error('O projeto proprietário do histórico precisa continuar vinculado.');
          }
          const config = companyDesignConfig(plan, previous);
          if (!draft.apply)
            draft = await write(
              {
                ...draft,
                apply: {
                  key,
                  companyId,
                  cardIds: Object.fromEntries(plan.tasks.map((t) => [t.id, randomUUID()])),
                  done: false,
                },
              },
              draft.revision,
            );
          const receipt = draft.apply!;
          if (!root)
            root = await sessions.createCompanySession({
              id: companyId,
              name: plan.name,
              project_ids: plan.projectIds,
              config_json: JSON.stringify({ ...config, design_pending: id }),
              runtime_kind: 'company',
            });
          else if (!draft.source && previous.design_pending !== id && previous.design_applied !== id)
            throw new Error('A empresa reservada pertence a outra operação.');
          await deps.sessionStore.ensureCatalog();
          const files = new CompanySessionFiles({
            companySessionId: asCompanySessionId(companyId),
            sessionStore: deps.sessionStore,
          });
          const cards = new CompanyKanbanFiles(files, id);
          const links = new CompanyKanbanRelations(files, cards);
          for (const task of plan.tasks) {
            const cardId = receipt.cardIds[task.id];
            if (!cards.getKanbanCardFullSync(cardId))
              cards.createKanbanCardSync({
                id: cardId,
                title: task.title,
                description: task.description,
                column: task.projectId ? 'todo' : 'backlog',
                control: {
                  owner: task.owner || null,
                  projectId: task.projectId,
                  visualQA: false,
                  acceptance: task.criteria.map((criterion) => ({ criterion, evidence: '' })),
                },
              });
          }
          for (const task of plan.tasks) {
            const card = cards.getKanbanCardFullSync(receipt.cardIds[task.id])!;
            for (const dependency of new Set(task.dependsOn)) {
              const target = receipt.cardIds[dependency];
              if (!card.dependencies.some((d) => d.depends_on_id === target))
                links.addKanbanDependencySync(card.id, target);
            }
          }
          if (plan.tasks.length && !draft.source) cards.publishDraftBatch();
          if (previous.design_applied !== id) {
            const clean: Record<string, unknown> = { ...config };
            delete clean.design_pending;
            await sessions.applyCompanyDesign(companyId, companyConfigRevision(root.config_json), {
              name: plan.name,
              projectIds: plan.projectIds,
              config: clean,
              draftId: id,
            });
          }
          if (plan.tasks.length && draft.source) cards.publishDraftBatch();
          const applied = await write({ ...draft, apply: { ...receipt, done: true } }, draft.revision);
          publishCompanyPanelChange(asCompanySessionId(companyId), { kind: 'settings' });
          return c.json(applied);
        });
      });
    } catch (error) {
      return failure(c, error);
    }
  });
}
