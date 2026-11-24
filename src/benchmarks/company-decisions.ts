/** Run with tsx. Default is entirely local. --live requires explicit Cloudflare credentials. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { AGENTS } from '@mcp/code-agent/agents/index.js';
import { decide } from '@mcp/code-agent/agents/decision-engine.js';
import {
  createRolePipeline,
  InMemoryRoleEmbeddingStore,
  recommendRoles,
} from '@mcp/company/role-pipeline/index.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import {
  ClefDecisions,
  clefInputUsdPerMillion,
  clefDeadlineMs,
  estimatedClefInputUsd,
  type DecisionCandidate,
} from '../../apps/http-api/server/clef-decisions.js';
import { evaluateClef } from '../../apps/http-api/server/clef-evaluation.js';

type Example = { kind: 'chat' | 'company'; text: string; expected: string | null; family: string };
type Prompts = Array<[string | null, string[]]>;
const company: Prompts = [
  [
    'analyst',
    [
      'Levante as fontes de {x} e identifique os responsáveis.',
      'Inventory the fields and owners used by {x}.',
      'Mapeie quem fornece os dados de {x} e produza uma matriz.',
      'Descubra de onde vêm as informações de {x}.',
    ],
  ],
  [
    'reviewer',
    [
      'Audite a matriz de {x} contra as cláusulas originais e cite os desvios.',
      'Independently review the proposed conclusions about {x}.',
      'Confira as divergências já apuradas de {x} e assine o parecer.',
      'Confronte o relatório de {x} com as duas fontes e aponte omissões.',
    ],
  ],
  [
    'engineer',
    [
      'Implemente a correção de {x} e atualize o código.',
      'Patch the broken serialization of {x}.',
      'Altere o adaptador de {x} para aceitar o novo formato.',
      'Corrija o defeito em {x} mantendo compatibilidade.',
    ],
  ],
  [
    'qa',
    [
      'Execute o teste de regressão de {x} e anexe o resultado.',
      'Reproduce the defect in {x} using the test suite.',
      'Monte a suíte de aceitação de {x} e registre a evidência.',
      'Faça a verificação funcional de {x} no ambiente de testes.',
    ],
  ],
  [
    null,
    [
      'Tenho uma dúvida sobre {x}, explico depois.',
      'Algo mudou em {x}.',
      'Someone mentioned {x}.',
      'Vamos conversar sobre {x} mais tarde.',
    ],
  ],
];
const chat: Prompts = [
  [
    'explore',
    [
      'Explique como {x} funciona no código.',
      'Where is {x} implemented?',
      'Encontre quem consome {x} e mostre as chamadas.',
      'Leia a implementação de {x} e explique o fluxo.',
    ],
  ],
  [
    'plan',
    [
      'Trace um plano de migração para {x}.',
      'Plan the milestones for rolling out {x}.',
      'Divida a entrega de {x} em etapas com dependências.',
      'Compare duas estratégias antes de alterar {x}.',
    ],
  ],
  [
    'build',
    [
      'Implemente {x} com testes.',
      'Fix the bug in {x}.',
      'Escreva o código que valida {x}.',
      'Adicione suporte ao novo formato de {x}.',
    ],
  ],
  [
    'research',
    [
      'Pesquise fontes externas sobre {x} e cite a documentação.',
      'Find published research about {x}.',
      'Investigue na literatura as práticas recentes para {x}.',
      'Consulte as recomendações dos fornecedores para {x}.',
    ],
  ],
  [
    'spec',
    [
      'Escreva uma SPEC com requisitos de {x}.',
      'Draft the acceptance criteria and specification for {x}.',
      'Formalize o contrato de {x} com cenários de aceite.',
      'Redija os requisitos funcionais de {x}.',
    ],
  ],
  [
    null,
    [
      'Tenho uma observação sobre {x}, continuo amanhã.',
      'Talvez {x}.',
      'About {x}…',
      'Só marquei {x} para lembrar depois.',
    ],
  ],
];
const roles: DecisionCandidate[] = [
  {
    id: 'analyst',
    description: 'Analista que descobre e mapeia fontes e requisitos e prepara a matriz inicial.',
  },
  {
    id: 'reviewer',
    description: 'Revisor independente que audita relatórios contra fontes e verifica conclusões.',
  },
  { id: 'engineer', description: 'Engenheiro responsável por implementar e corrigir o código.' },
  { id: 'qa', description: 'Testador que reproduz falhas e executa a suíte de aceitação com evidências.' },
];
const profiles = [AGENTS.explore, AGENTS.plan, AGENTS.build, AGENTS.research, AGENTS.spec].map((p) => ({
  id: String(p.id),
  description: p.description,
}));
const evaluationFamilies = [
  'conciliação de faturas',
  'catálogo de fornecedores',
  'histórico de pedidos',
  'agenda de entregas',
  'contratos comerciais',
];
// The independent calibration family can be run separately. The two sets never share an entity.
const families = process.argv.includes('--calibration') ? ['cadastro de produtos'] : evaluationFamilies;
const examples: Example[] = families.flatMap((family) =>
  (['company', 'chat'] as const).flatMap((kind) =>
    (kind === 'company' ? company : chat).flatMap(([expected, prompts]) =>
      prompts.map((text) => ({ kind, expected, family, text: text.replace('{x}', family) })),
    ),
  ),
);
const live = process.argv.includes('--live');
if (
  live &&
  (!/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '') || !process.env.CLOUDFLARE_API_TOKEN)
)
  throw Error('Supply CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for the synthetic live benchmark.');
const embedding = new LocalEmbeddingService({ cacheDir: tmpdir() });
const pipeline = createRolePipeline({
  embed: async (text) => Float32Array.from((await embedding.embedQuery(text)).vector),
  roleEmbeddingStore: new InMemoryRoleEmbeddingStore(),
});
// One native request per case. The longer measurement window also counts which answers
// would have met the desktop deadline. Reserve the full published context before each call.
const maxUsd = Number(process.argv.find((arg) => arg.startsWith('--max-usd='))?.split('=')[1] ?? '0.10');
if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw Error('Invalid benchmark budget.');
const contextTokens = 24576;
const tokenLimit = Math.floor((maxUsd * 1_000_000) / clefInputUsdPerMillion);
const ledger = process.argv.find((arg) => arg.startsWith('--budget-file='))?.slice('--budget-file='.length);
let reservedTokens = live && ledger && existsSync(ledger) ? Number(readFileSync(ledger, 'utf8')) : 0;
if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 0) throw Error('Invalid benchmark ledger.');
function saveBudget(value: number) {
  reservedTokens = value;
  if (!ledger) return;
  writeFileSync(ledger + '.tmp', String(value));
  renameSync(ledger + '.tmp', ledger);
}
let blocked: string | null = null;
const diagnostics: Record<string, unknown> = {};
const clef = new ClefDecisions(async (url, init) => {
  const response = await fetch(url, init);
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  const tokens = body?.result?.usage?.input_tokens;
  if (Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= contextTokens) {
    saveBudget(reservedTokens - contextTokens + tokens);
  }
  if (!response.ok) {
    const codes = Array.isArray(body?.errors)
      ? body.errors.map((e: { code?: unknown }) => Number(e.code)).filter(Number.isFinite)
      : [];
    diagnostics['http_' + response.status] = { codes };
    if ([400, 401, 403, 404, 429].includes(response.status)) blocked = 'http_' + response.status;
  } else if (body?.result?.answers?.pick && !diagnostics.answerFields) {
    diagnostics.answerFields = Object.keys(body.result.answers.pick);
  }
  return response;
}, 15_000);
const rows: Array<{
  example: Example;
  baseline: string | null;
  ms: number;
  remote?: Awaited<ReturnType<ClefDecisions['decide']>>;
}> = [];
const percentile = (times: number[], p: number) =>
  times.length ? [...times].sort((a, b) => a - b)[Math.ceil(times.length * p) - 1] : null;
const maxRequests = examples.length;
let calls = 0;
try {
  for (const example of examples) {
    const start = performance.now();
    let baseline: string | null;
    let candidates = profiles;
    if (example.kind === 'company') {
      const ranked = await recommendRoles(pipeline, {
        queryId: example.text,
        taskText: example.text,
        k: 5,
        availableRoles: roles.map((r) => ({ role: r.id, description: r.description, skills: [] })),
      });
      candidates = ranked.recommendations.flatMap((row) => roles.filter((r) => r.id === row.role));
      baseline = candidates[0]?.id ?? null;
    } else baseline = decide(example.text).recommendedAgent;
    const ms = performance.now() - start;
    const remote = live
      ? await clef.decide({
          kind: example.kind,
          scope: 'synthetic:' + example.family,
          text: example.text,
          candidates,
          mode: 'suggest',
          provider: 'cloudflare',
          connection: () => ({
            account: process.env.CLOUDFLARE_ACCOUNT_ID!,
            token: process.env.CLOUDFLARE_API_TOKEN!,
          }),
          reserve: () => {
            if (blocked || calls >= maxRequests || reservedTokens + contextTokens > tokenLimit) return false;
            saveBudget(reservedTokens + contextTokens);
            calls++;
            return true;
          },
        })
      : undefined;
    rows.push({ example, baseline, ms, remote });
    if (live && (rows.length === 1 || rows.length % 25 === 0))
      console.error(
        'Synthetic benchmark',
        rows.length,
        '/',
        examples.length,
        'requests',
        calls,
        'last',
        remote?.reason,
      );
    if (live && rows.length === 3 && rows.every((r) => r.remote?.reason === 'unavailable'))
      blocked = 'transport_or_schema';
  }
  const surfaces = Object.fromEntries(
    (['company', 'chat'] as const).map((kind) => {
      const surface = rows.filter((row) => row.example.kind === kind);
      const decisions = surface.flatMap((row) => (row.remote ? [row.remote] : []));
      const times = decisions.filter((r) => r.reason !== 'budget').map((r) => r.latencyMs);
      const assess = (withinMs: number) =>
        evaluateClef(
          surface.map((r) => ({
            key: r.example.text,
            shown: r.remote?.candidate != null && r.ms + r.remote.latencyMs <= withinMs,
            correct: r.remote?.candidate === r.example.expected,
            baselineCorrect: r.baseline === r.example.expected,
          })),
        );
      const meteredTokens = decisions.reduce((n, r) => n + (r.tokens ?? 0), 0);
      return [
        kind,
        {
          cases: surface.length,
          ambiguous: surface.filter((x) => x.example.expected === null).length,
          baselineCorrect: surface.filter((r) => r.baseline === r.example.expected).length,
          baselineP50Ms: percentile(
            surface.map((x) => x.ms),
            0.5,
          ),
          baselineP95Ms: percentile(
            surface.map((x) => x.ms),
            0.95,
          ),
          ...(live && {
            clef: assess(Infinity),
            withinDesktopBudget: assess(clefDeadlineMs),
            within800ms: surface.filter(
              (r) =>
                r.remote &&
                ['ok', 'abstain'].includes(r.remote.reason) &&
                r.ms + r.remote.latencyMs <= clefDeadlineMs,
            ).length,
            displayed: decisions.filter((r) => r.candidate != null).length,
            correctDisplayed: surface.filter(
              (r) => r.remote?.candidate != null && r.remote.candidate === r.example.expected,
            ).length,
            p50Ms: percentile(times, 0.5),
            p95Ms: percentile(times, 0.95),
            responses: decisions.reduce<Record<string, number>>(
              (tot, r) => ({ ...tot, [r.reason]: (tot[r.reason] ?? 0) + 1 }),
              {},
            ),
            reportedInputTokens: meteredTokens,
            estimatedUsdFromReportedTokens: estimatedClefInputUsd(meteredTokens),
            usdPerMillionInputTokens: clefInputUsdPerMillion,
            tokensUnknown: decisions.filter((r) => r.tokens === null).length,
          }),
        },
      ];
    }),
  );
  console.log(
    JSON.stringify(
      {
        dataset: 'synthetic-v1',
        families,
        live,
        calls,
        ...(live && { maxUsd, upperBoundUsd: estimatedClefInputUsd(reservedTokens), blocked, diagnostics }),
        embedding: embedding.fingerprint(),
        surfaces,
      },
      null,
      2,
    ),
  );
} finally {
  await embedding.dispose();
}
