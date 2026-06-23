# Bench / baseline workflow

Diretório de baselines para o MCP IDE. **Princípio**: antes de qualquer mudança em runner, indexer, pipelines ou orchestrator, capturamos um snapshot do comportamento atual aqui. Depois da mudança, re-rodamos e diffamos. Regressão acima dos critérios → flag OFF imediato (ver plano).

## Quais baselines existem

| Baseline | O que mede | Script | Output |
|---|---|---|---|
| **runner** | tokens/turn, turns/session, compaction rate, tool distribution, cost USD | `src/benchmarks/runner-baseline.ts` | `bench/results/runner-baseline-YYYY-MM-DD.json` |
| **pipeline-telemetry** | p50/p95/p99 latency, cache hit rate, candidate fan-out por (pipeline, stage, component) | `src/benchmarks/pipeline-telemetry-baseline.ts` | `bench/results/pipeline-telemetry-baseline-YYYY-MM-DD.json` |
| **search-quality** | recall@5, recall@10, MRR, p50/p95 latency por search mode | `src/benchmarks/search-quality.ts` | `bench/results/search-baseline-YYYY-MM-DD.json` (com `--save-baseline`) |
| **framework primitives** | p50/p95/p99 + ops/sec de RRF, cosine, LSH, selectors, LRU | `packages/candidate-pipeline/bench/baseline.ts` | `bench/results/baseline-YYYY-MM-DD.json` |
| **hot-state cache** | bench específico de cache hot-state | `packages/candidate-pipeline/bench/bench-hot-state-cache.ts` | `bench/results/hot-state-cache-baseline-YYYY-MM-DD.json` |

Os 3 primeiros leem dados que **já existem** (telemetry tables) — zero API calls.
Os 2 últimos rodam workloads sintéticos em-processo — também zero rede.

## Como rodar (Sprint 0 — pré-flight)

Antes de qualquer mudança das recomendações do plano (`plans/https-github-com-xai-org-x-algorithm-clo-shimmying-oasis.md`), rodar:

```bash
# 1. Runner baseline (lê coder_turn_telemetry + coder_tool_calls)
pnpm tsx src/benchmarks/runner-baseline.ts

# 2. Pipeline telemetry baseline (lê pipeline_telemetry)
pnpm tsx src/benchmarks/pipeline-telemetry-baseline.ts

# 3. Search-quality baseline (rerun do eval-framework + persistir JSON)
#    Requer projeto indexado.
pnpm tsx src/benchmarks/search-quality.ts \
  --project <project-name> \
  --modes fts,hybrid,expanded \
  --save-baseline

# 4. Framework primitives baseline
pnpm tsx packages/candidate-pipeline/bench/baseline.ts
```

Output: 4 arquivos `bench/results/*-YYYY-MM-DD.json`. Commit no repo pra ter histórico.

### Filtros opcionais

Todos os 3 scripts de telemetria suportam `--since YYYY-MM-DD` pra restringir o intervalo. Útil quando você quer comparar "antes do feature X" sem ter dados muito antigos enviesando.

```bash
pnpm tsx src/benchmarks/runner-baseline.ts --since 2026-05-01
pnpm tsx src/benchmarks/pipeline-telemetry-baseline.ts --since 2026-05-01 --pipeline tool_selection
pnpm tsx src/benchmarks/search-quality.ts --project foo --save-baseline --output bench/results/search-pre-i1.json
```

## Como comparar (pós-mudança)

```bash
# 1. Salvar baseline ANTES da mudança (Sprint 0, acima)
# 2. Implementar a mudança atrás de flag OFF
# 3. Rodar testes existentes — devem passar sem alterações
# 4. Ligar a flag em ambiente de dev/staging
# 5. Re-rodar os baselines (mesmos scripts) → output novo arquivo YYYY-MM-DD
# 6. Diffar
diff bench/results/runner-baseline-2026-05-25.json \
     bench/results/runner-baseline-2026-06-01.json
```

Pra comparar com mais clareza, recomendado abrir os JSONs lado a lado num editor ou usar `jq` para extrair campos específicos:

```bash
# p95 de input_tokens antes vs depois
jq '.tokens.input.p95' bench/results/runner-baseline-2026-05-25.json
jq '.tokens.input.p95' bench/results/runner-baseline-2026-06-01.json

# p95 latency de tool_selection stage scorer
jq '.pipelines[] | select(.pipeline_name=="tool_selection") | .stages[] | select(.stage=="scorer") | .durationMs.p95' \
   bench/results/pipeline-telemetry-baseline-2026-05-25.json
```

## Critérios de revert (do plano)

Qualquer um dispara `flag OFF` imediato:

- Completion rate cai >2% no corpus de baseline
- Tokens-por-task sobem >5% no corpus de baseline (ver `tokens.input.mean` + `tokens.output.mean` do runner-baseline)
- p95 latency sobe >10% em hot path (runner turn ou search; ver `durationMs.p95` do pipeline baseline)
- Doom-loop incidence sobe acima do baseline
- `decisionMarkersDropped` em compaction sobe acima do baseline (capturar via `--diag-json` quando o pipeline `context_relevance` é instrumentado)
- Qualquer teste existente quebra

## Estrutura dos JSONs

### runner-baseline-*.json

```jsonc
{
  "generatedAt": "ISO8601",
  "schemaVersion": 105,
  "filters": { "since": "..." },
  "summary": {
    "totalRows": 1234,         // # de turns telemetrados
    "distinctSessions": 87,
    "distinctRuns": 102,
    "mainAgentTurns": 1000,
    "subagentTurns": 234,
    "dateRange": { "from": "...", "to": "..." }
  },
  "tokens": {
    "input":  { "count", "min", "max", "mean", "p50", "p95", "p99", "total" },
    "output": { ... },
    "cacheRead": { ... },
    "cacheCreation": { ... },
    "thinking": { ... }
  },
  "context": {
    "historyChars": { ... },        // tamanho do histórico em chars
    "systemPromptChars": { ... },   // system prompt slice
    "toolsDefChars": { ... },       // tools schema slice
    "largestToolResultChars": { ... }
  },
  "compaction": {
    "triggerRate": 0.12,    // 12% das turns acionaram compaction
    "summarizerRate": 0.03, // 3% rodaram summarizer
    "paginateCount": { ... }
  },
  "tools": {
    "totalCalls": 5678,
    "truncationRate": 0.04,
    "top20ByCount": [
      { "tool_name": "Read", "calls": 1234, "avg_output_chars": 8000, "p95_output_chars": 24000, "truncated_rate": 0.02 },
      ...
    ],
    "phaseDistribution": [
      { "phase": "search", "count": 800, "share": 0.14 },
      ...
    ]
  },
  "turnsPerSession": {
    "stat": { ... },
    "histogram": [ { "bucket": "1", "count": 5 }, { "bucket": "2-3", "count": 12 }, ... ]
  },
  "estimatedCostUsd": {
    "totalAllTime": 12.345,
    "perTurn": { ... }
  }
}
```

### pipeline-telemetry-baseline-*.json

```jsonc
{
  "generatedAt": "...",
  "schemaVersion": 105,
  "filters": { "since": "...", "pipeline": "..." },
  "totalRows": 56789,
  "pipelines": [
    {
      "pipeline_name": "tool_selection",
      "totalInvocations": 1000,
      "stages": [
        {
          "stage": "query_hydrator",
          "component_name": "task_embedding",
          "invocations": 1000,
          "durationMs": { "p50", "p95", "p99", "mean", "min", "max" },
          "candidatesIn": null,
          "candidatesOut": { "p50", "p95", "mean" },
          "cache": { "hits", "misses", "hitRate" },
          "errors": 2
        },
        ...
      ],
      "durationByBucket": [
        { "bucket": "0-10ms", "count": 800 },
        { "bucket": "0-50ms", "count": 180 },
        ...
      ]
    },
    ...
  ]
}
```

### search-baseline-*.json (search-quality com `--save-baseline`)

```jsonc
{
  "generatedAt": "...",
  "project": "...",
  "projectId": 1,
  "querySource": "evals/queries.jsonl",
  "queryCount": 25,
  "hyde": "real",
  "modes": ["fts", "hybrid", "expanded"],
  "results": [
    { "mode": "fts", "recall_at_5": 0.6, "recall_at_10": 0.72, "mrr": 0.45, "median_ms": 12, "p95_ms": 45, "queries": 25 },
    { "mode": "hybrid", ... },
    { "mode": "expanded", ... }
  ]
}
```

## Pré-requisitos por baseline

- **runner-baseline**: o DB tem que ter `coder_turn_telemetry` populado — i.e., o usuário já rodou o agente algumas vezes. Se a tabela está vazia o script aborta com mensagem clara.
- **pipeline-telemetry-baseline**: `pipeline_telemetry` populada. Como vários pipelines (`tool_selection`, `context_relevance`, etc) são opt-in via `MCP_PIPELINES_*`, pode estar vazia em DBs frescos.
- **search-quality**: projeto indexado + (opcional) vector store + embedding provider configurados.
- **framework primitives**: nenhum — workload sintético em-processo.

## Roadmap

Quando implementarmos itens do plano:
- **X2 (Bench discipline)** ✅ — `compare-baselines.ts` shipped. CI YAML é follow-up.
- **A1 (Decider-ize)** muda hardcoded limits → não deve mudar nenhuma métrica em default. Re-rodar `runner-baseline` ANTES de mexer e DEPOIS de mexer (com flag default) — números têm que ser idênticos (±2% de variação natural).
- **I1 (HybridSearch migrate)** → re-rodar `pipeline-telemetry-baseline --pipeline indexer_search` + `search-quality` antes e depois.
- **I2 (Thunder)** → re-rodar `search-quality` antes e depois — esperamos R@10 ↑ e p95 ↓.

---

## X2 — Comparação de baselines (Sprint 2)

`src/benchmarks/compare-baselines.ts` diffa dois snapshots e reporta regressões contra os critérios do plano. Output markdown — colável em PR comment.

```bash
# Compare runner baselines (antes vs depois de uma mudança)
pnpm tsx src/benchmarks/compare-baselines.ts \
  --before bench/results/runner-baseline-2026-05-25.json \
  --after  bench/results/runner-baseline-2026-06-01.json

# Same para pipeline-telemetry ou search-quality (auto-detecta o tipo)
pnpm tsx src/benchmarks/compare-baselines.ts \
  --before bench/results/search-baseline-2026-05-25.json \
  --after  bench/results/search-baseline-2026-06-01.json
```

**Thresholds (do plano)**:

| Critério | Limiar | Status |
|---|---|---|
| Completion rate cai | >2pp | ❌ revert |
| Tokens-per-task sobem | >5% | ❌ revert |
| p95 latency hot path sobe | >10% | ❌ revert |
| Recall@10 cai | >5pp | ❌ revert |
| Compaction trigger rate sobe | >1pp | ❌ revert |

Exit codes:
- `0` — todos os thresholds atendidos
- `1` — pelo menos um threshold violado (revert flag OFF)
- `2` — erro de uso (argumentos inválidos, arquivo não encontrado, kinds diferentes)

### Integração CI (follow-up — não-Sprint-1)

Skeleton de workflow GitHub Actions (`.github/workflows/bench-diff.yml`, NÃO commitado ainda):

```yaml
name: Bench diff
on:
  pull_request:
    paths:
      - 'packages/code-agent/**'
      - 'packages/indexer/**'
      - 'packages/candidate-pipeline/**'
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - name: Restore main baseline
        run: |
          # Pull pre-merge baseline from a known location
          # (manual seed first run; subsequent runs use cached artifact)
      - name: Run baselines on PR head
        run: |
          pnpm tsx packages/candidate-pipeline/bench/baseline.ts
          # Runner + pipeline-telemetry need a DB — skip in CI or use a sample
      - name: Compare
        run: |
          pnpm tsx src/benchmarks/compare-baselines.ts \
            --before bench/results/main-baseline.json \
            --after  bench/results/baseline-$(date -u +%Y-%m-%d).json
```

CI wiring depends on the repo's deployment story (which CI provider, secret management, where baselines are cached). The `compare-baselines.ts` script is provider-agnostic.
