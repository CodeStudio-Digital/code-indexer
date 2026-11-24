import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decide } from '@mcp/code-agent/agents/decision-engine.js';
import { AGENTS } from '@mcp/code-agent/agents/index.js';
import { asCompanySessionId, asSessionId } from '@mcp/session-storage';
import type { HttpContext } from '@mcp/shared/http/context.js';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import { clefPolicyVersion, clefQualification, type ClefObservation } from '../../clef-evaluation.js';
import {
  ClefDecisions,
  clefInputUsdPerMillion,
  clefDeadlineMs,
  estimatedClefInputUsd,
  decisionSettings,
  defaultDecisionSettings,
  resolveDecisionMode,
} from '../../clef-decisions.js';
import type { ServerDeps } from '../../deps.js';
import { sessionRoles } from './session-role-roster.js';
import { recommendRolesForSession } from './recommend-core.js';

const mode = z.enum(['inherit', 'off', 'shadow', 'suggest']);
const surface = z.enum(['company', 'chat']);
const generalKey = 'clef.settings.v1';
const dailyKey = 'clef.usage.v1';
const counters = () => ({
  date: new Date().toISOString().slice(0, 10),
  requests: 0,
  meteredRequests: 0,
  tokens: 0,
  accepted: 0,
  corrected: 0,
  abstained: 0,
  failures: 0,
  latencyMs: 0,
  shadowCompared: 0,
  shadowAgreed: 0,
});
const chatOptions = [AGENTS.explore, AGENTS.plan, AGENTS.build, AGENTS.research, AGENTS.spec];
export function mountDecisionRoutes(
  app: HttpRouter,
  deps: ServerDeps,
  clef = new ClefDecisions(),
  recommend = recommendRolesForSession,
) {
  const db = deps.providerStore;
  const overrides = (kind: string, id: string) =>
    mode.catch('inherit').parse(db.getAppSetting('clef.' + kind + '.' + id));
  const settings = () =>
    decisionSettings.parse(
      JSON.parse(db.getAppSetting(generalKey) ?? JSON.stringify(defaultDecisionSettings)),
    );
  const usage = () => {
    const today = counters();
    const saved = JSON.parse(db.getAppSetting(dailyKey) ?? 'null');
    return saved?.date === today.date ? ({ ...today, ...saved } as ReturnType<typeof counters>) : today;
  };
  const samples = new Map<
    string,
    {
      key: string;
      scope: string;
      provider: string;
      predicted: string | null;
      baseline: string | null;
      options: string[];
    }
  >();
  const evidenceKey = (kind: string, provider: string) =>
    'clef.evaluation.' + clefPolicyVersion + '.' + kind + '.' + provider;
  function observations(kind: string, provider: string): ClefObservation[] {
    return JSON.parse(db.getAppSetting(evidenceKey(kind, provider)) ?? '[]');
  }
  function quality(kind: z.infer<typeof surface>, provider: string) {
    return clefQualification(kind, observations(kind, provider));
  }
  async function policy(c: HttpContext) {
    const kind = surface.parse(c.req.param('kind'));
    const id = z.string().uuid().parse(c.req.param('id'));
    const cfg = settings();
    let fixedProfile: string | null = null;
    let parent: ReturnType<typeof mode.parse> = 'inherit';
    if (kind === 'company') {
      const session = await deps.operationalSessionFiles.getCompanySession(id);
      if (!session || session.runtime_kind !== 'company') throw new Error('Empresa indisponível.');
      if (session.parent_session_id) parent = overrides(kind, session.parent_session_id);
    } else {
      const session = await deps.sessionStore.getSession(asSessionId(id));
      if (!session) throw new Error('Chat indisponível.');
      fixedProfile = session.agent ?? null;
    }
    const own = overrides(kind, id);
    const requested = resolveDecisionMode(cfg, own, parent);
    const calibrating = requested === 'suggest' && !quality(kind, cfg.provider).canSuggest;
    return {
      kind,
      id,
      own,
      fixedProfile,
      enabled: cfg.enabled,
      calibrating,
      effective: calibrating ? 'shadow' : requested,
      origin: !cfg.enabled
        ? 'installation'
        : own !== 'inherit'
          ? 'session'
          : parent !== 'inherit'
            ? 'company'
            : 'installation',
    };
  }
  function credentials(providerId: string) {
    const p = db.getProvider(providerId);
    if (!p?.enabled || p.kind !== 'cloudflare') return null;
    return {
      account: String(
        p.extra.account_id || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '',
      ),
      token: p.api_key || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '',
    };
  }
  const admin = '/api/admin/clef';
  app.get(admin, (c) => {
    const cfg = settings();
    const totals = usage();
    return c.json({
      settings: cfg,
      usage: totals,
      estimate: {
        usd: estimatedClefInputUsd(totals.tokens),
        usdPerMillion: clefInputUsdPerMillion,
        unmetered: Math.max(0, totals.requests - totals.meteredRequests),
      },
      quality: { company: quality('company', cfg.provider), chat: quality('chat', cfg.provider) },
      providers: db.listProviderIdentities().filter((p) => p.enabled && p.kind === 'cloudflare'),
    });
  });
  app.patch(admin, async (c) => {
    const parsed = decisionSettings.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Configuração de decisões inválida.' }, 400);
    if (parsed.data.enabled && !credentials(parsed.data.provider)?.token)
      return c.json({ error: 'Configure um provedor Cloudflare com token.' }, 400);
    if (parsed.data.enabled && !/^[a-f\d]{32}$/i.test(credentials(parsed.data.provider)?.account ?? ''))
      return c.json({ error: 'Configure o Account ID da Cloudflare.' }, 400);
    db.setAppSetting(generalKey, JSON.stringify(parsed.data));
    clef.invalidate();
    samples.clear();
    return c.json({ settings: parsed.data, usage: usage() });
  });
  const path = '/api/decisions/:kind/:id';
  app.get(path, async (c) => {
    try {
      return c.json(await policy(c));
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });
  app.patch(path, async (c) => {
    try {
      const p = await policy(c);
      const next = mode.parse(((await c.req.json()) as { mode?: string }).mode);
      db.setAppSetting('clef.' + p.kind + '.' + p.id, next);
      clef.invalidate();
      samples.clear();
      return c.json(await policy(c));
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });
  app.post(path + '/suggest', async (c) => {
    const deadlineAt = Date.now() + clefDeadlineMs;
    try {
      const p = await policy(c);
      const input = z
        .object({
          text: z.string().trim().min(1).max(1200),
          cardId: z.string().uuid().optional(),
          source: z.enum(['manual', 'sample']).default('manual'),
        })
        .parse(await c.req.json());
      if (p.effective === 'off') return c.json({ candidate: null, reason: 'off' });
      if (input.source === 'sample' && p.effective !== 'shadow')
        return c.json({ candidate: null, reason: 'off' });
      if (p.fixedProfile) return c.json({ candidate: null, reason: 'fixed' });
      const scope = p.kind + ':' + p.id;
      // Skip unsampled events before loading the board or computing embeddings.
      if (
        p.effective === 'shadow' &&
        input.source === 'sample' &&
        createHash('sha256')
          .update(scope + input.text)
          .digest()[0] %
          5 !==
          0
      )
        return c.json({ candidate: null, reason: 'sampled_out' });
      const cfg = settings();
      let candidates = chatOptions.map((a) => ({ id: String(a.id), description: a.description }));
      if (p.kind === 'company') {
        if (!input.cardId) return c.json({ error: 'Selecione uma tarefa.' }, 400);
        const { CompanySessionFiles } = await import('@mcp/company/services/CompanySessionFiles.js');
        await deps.sessionStore.ensureCatalog();
        const requested = new CompanySessionFiles({
          companySessionId: asCompanySessionId(p.id),
          sessionStore: deps.sessionStore,
        });
        const session = requested.getSession();
        const root = session.parent_session_id
          ? new CompanySessionFiles({
              companySessionId: session.parent_session_id,
              sessionStore: deps.sessionStore,
            })
          : requested;
        const card = root.getKanbanCardFullSync(input.cardId);
        if (!card || card.control?.owner) return c.json({ candidate: null, reason: 'fixed' });
        const roster = sessionRoles(deps, session);
        const rec = await recommend(deps, {
          companySessionId: asCompanySessionId(p.id),
          taskText: input.text,
          k: 5,
          projectId: card.control?.projectId,
        });
        candidates = rec.recommendations.flatMap((item) => {
          const role = roster.find((r) => r.role === item.role);
          if (
            !role ||
            role.enabled === false ||
            role.role === 'master' ||
            (card.control?.projectId &&
              role?.projectIds?.length &&
              !role.projectIds.includes(card.control.projectId))
          )
            return [];
          return [{ id: item.role, description: role?.systemPromptOverride || item.role }];
        });
      }
      const baseline = p.kind === 'chat' ? decide(input.text).recommendedAgent : (candidates[0]?.id ?? null);
      const unique = [...new Map(candidates.map((v) => [v.id, v])).values()];
      const eligible = await policy(c);
      if (eligible.fixedProfile || eligible.effective !== p.effective)
        return c.json({ candidate: null, reason: 'cancelled' });
      const result = await clef.decide({
        deadlineAt,
        kind: p.kind,
        scope,
        text: input.text,
        candidates: unique,
        mode: p.effective,
        provider: cfg.provider,
        connection: () => credentials(cfg.provider),
        reserve: () => {
          const u = usage();
          if (u.requests >= cfg.dailyLimit) return false;
          u.requests++;
          db.setAppSetting(dailyKey, JSON.stringify(u));
          return true;
        },
      });
      const latest = await policy(c);
      if (latest.fixedProfile || latest.effective !== p.effective)
        return c.json({ candidate: null, reason: 'cancelled' });
      const u = usage();
      if (result.tokens !== null) u.meteredRequests++;
      u.tokens += result.tokens ?? 0;
      u.latencyMs += result.latencyMs;
      if (result.reason === 'abstain') u.abstained++;
      else if (!['ok', 'cache', 'budget', 'capacity', 'off'].includes(result.reason)) u.failures++;
      if (p.effective === 'shadow' && result.candidate) {
        u.shadowCompared++;
        if (result.candidate === baseline) u.shadowAgreed++;
      }
      db.setAppSetting(dailyKey, JSON.stringify(u));
      if (Date.now() > deadlineAt) return c.json({ candidate: null, reason: 'timeout' });
      if (input.source === 'sample') return c.json({ candidate: null, reason: result.reason });
      const sampleId = randomUUID();
      if (samples.size >= 512) samples.delete(samples.keys().next().value!);
      const key = createHash('sha256')
        .update(JSON.stringify([scope, input.text, unique]))
        .digest('hex');
      if (!['ok', 'abstain', 'cache'].includes(result.reason))
        return c.json({ candidate: null, reason: result.reason });
      const options = unique.map((option) => option.id);
      samples.set(sampleId, {
        scope,
        key,
        provider: cfg.provider,
        predicted: result.candidate,
        baseline,
        options,
      });
      return c.json({
        candidate: p.effective === 'suggest' ? result.candidate : null,
        reason: result.reason,
        sampleId,
        options,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });
  app.post(path + '/feedback', async (c) => {
    try {
      const { kind, id, effective } = await policy(c);
      const input = z
        .object({ sampleId: z.string().uuid(), choice: z.string().max(160).nullable() })
        .parse(await c.req.json());
      const sample = samples.get(input.sampleId);
      if (!sample || effective === 'off' || sample.scope !== kind + ':' + id)
        return c.json({ recorded: false });
      if (input.choice !== null && !sample.options.includes(input.choice))
        return c.json({ error: 'Opção inválida.' }, 400);
      samples.delete(input.sampleId);
      const u = usage();
      const correct = sample.predicted === input.choice;
      if (correct) u.accepted++;
      else u.corrected++;
      const history = observations(kind, sample.provider).filter((row) => row.key !== sample.key);
      history.push({
        key: sample.key,
        shown: sample.predicted !== null,
        correct,
        baselineCorrect: sample.baseline === input.choice,
      });
      db.setAppSetting(evidenceKey(kind, sample.provider), JSON.stringify(history.slice(-512)));
      db.setAppSetting(dailyKey, JSON.stringify(u));
      return c.json({ recorded: true });
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });
}
