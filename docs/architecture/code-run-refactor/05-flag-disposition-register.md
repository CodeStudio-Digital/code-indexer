# 05 — Registro de disposição das flags

> **Status:** classificação aplicada; inventário AST é o oracle de cobertura
> **Regra:** este registro governa destino; o inventory gerado em P0 governa
> cobertura exata de consumers e valores

## 1. Classes

| Classe | Destino |
|---|---|
| `DELETE_DEAD` | remover consumer residual, catálogo, row, docs e telemetry |
| `BAKE_ON` | comportamento obrigatório; remover branch e toggle |
| `BAKE_OFF` | remover comportamento automático e branch |
| `TYPED_POLICY` | campo agrupado/preset da `RuntimePolicy` |
| `CODE_CONSTANT` | constante interna com teste/benchmark, sem UI/env |
| `BOOTSTRAP_ENV` | allowlist de segredo/bootstrap/diagnóstico |
| `ROLLOUT_TEMP` | flag temporária com owner, expiry e gate de remoção |
| `MOVE_DOMAIN` | sair do code-run e pertencer ao domínio responsável |

## 2. Remoção confirmada

### `DELETE_DEAD`

| Chave/família | Evidência/decisão |
|---|---|
| `CODER_MAX_AUTO_CONTINUES` | sem consumer atual; row SQLite obsoleta |
| `CODER_PROFILE_AUTO` | setting independente não controla o heuristic path atual |
| `CODER_BT_ENABLED` | comentário legado; BT é o único caminho TS atual |
| `CODER_LEGACY_RUNNER` | alias/no-op legado |
| `MCP_PIPELINES_CONTEXT_RELEVANCE` | runner não invoca; source foi construída vazia |
| `MCP_PIPELINES_TOOL_SELECTION*` | top-32 default aplicado após cap-28; retirar enable/apply/K com o selector legado |
| `MCP_SHADOW_TOOL_SELECTION_RATE` | retirar com selector legado ineficaz |
| `MCP_PIPELINES_SUB_AGENT_CACHE` | nenhum hit de spawn e chave insegura/incompleta |
| `MCP_PIPELINES_HOT_CACHE` | sem consumer de produção |
| `MCP_PIPELINES_INDEXER_SEARCH_V2` | sem consumer de produção |
| `MCP_PIPELINES_POLICY_HARD_BLOCK*` | resíduos retirados/sem efeito atual |
| `MCP_PIPELINES_QUALITY_CLASSIFIERS` | sistema consultivo já retirado |
| `MCP_PIPELINES_TODO_PRIORITY` | sem consumer atual |
| `MCP_PIPELINES_RECENT_FILES_SOURCE` | resíduo documental no caminho auditado |
| `MCP_QUALITY_ALERT_*` | sem consumer atual |
| `MCP_QUALITY_NUDGE_WAIT_TIMEOUT_MS` | sem consumer atual |
| `MCP_QUALITY_WATCHDOG_ENABLED` | sem consumer atual |

P0 deve revalidar o baseline e produzir migration que também remove rows
desconhecidas. Se um consumer reaparecer, a chave não é automaticamente
preservada: precisa provar valor operacional e receber nova classificação.

## 3. Comportamento obrigatório

### `BAKE_ON`

As seguintes famílias deixam de poder ser desligadas no produto normal:

- loop atual do agente (`CODER_AGENT_LOOP_V2`);
- compaction/summarization/reducer atuais aprovados
  (`CODER_NEW_COMPACTION`, `CODER_ROLLING_REDUCER`,
  `CODER_STRUCTURED_SUMMARY`, `CODER_SUMMARIZER_ENABLE`,
  `CODER_COMPACT_PRECOMPUTE`);
- conversation chapters (`CODER_CONVERSATION_CHAPTERS`);
- sticky deterministic profile (`CODER_STICKY_PROFILE`);
- failure classification e objective guards;
- read coverage e downgrade seguro;
- priority trimming e tool-pin behavior enquanto o legado existir;
- nested guards/telemetry;
- tool argument compatibility durante a janela definida;
- stale-task protection;
- policy/fencing/approval/output limits e cleanup.

Flags inversas como `*_DISABLE` são eliminadas. Parâmetros internos dessas
features migram para `CODE_CONSTANT` ou para um preset tipado quando forem
verdadeiro budget operacional.

### `BAKE_OFF`

- auto self-review/nudge (`CODER_SELF_REVIEW`) fica desligado por default no
  baseline; a capability explícita de revisão continua disponível;
- qualquer pipeline consultiva sem efeito de próxima ação permanece removida;
- debug (`CODER_BT_DEBUG`, provider/worker debug) continua desligado por default
  e só existe na allowlist diagnóstica.

## 4. Política tipada por família

| Família atual | Campo/preset alvo |
|---|---|
| `CODER_PROFILE`, agentless/subagent availability | `productPreset` + `capabilities` |
| `CODER_DISABLED_MCP_TOOLS`, caps, tiers e visible caps | `CapabilityProjectionPolicy` |
| `CODER_MODEL_CAPS`, pricing/fallback | registry versionado + `ProviderPolicy` |
| `CODER_STREAM_*`, `CODER_TRANSIENT_RETRY_*`, `CODER_RECOVERY_*` | `ProviderPolicy.deadlines/retryBudget` |
| `CODER_PUSH_TIME_CAP`, `CODER_TURN_BUDGET_CHARS`, prune/compact/output caps | `ContextPolicy` preset |
| `CODER_SPAWN_*`, `CODER_SUBAGENT_*`, `CODER_PARALLEL_*` | `SubagentPolicy` preset |
| `CODER_TASK_*`, `CODER_TASKS_*` | `ExecutionBudgetPolicy.taskProfiles` |
| `CODER_BACKGROUND_*`, resume/workflow TTLs | lifecycle policy/owner service |
| `CODER_CODE_EXEC_*`, `CODER_UNRESTRICTED_*` | `HostResourcePolicy.codeExecPreset` |
| `CODER_WORKER_*`, watchdog | deployment `HostRuntimeConfig` |
| `CODER_WEB_*` | capability HTTP policy |
| `CODER_COMPANY_*`, subordinate retry/limits | Company policy preset |
| `CODER_MEMORY_*` | memory/retrieval domain policy |

“Typed” não significa que todo valor aparece na UI. A maioria é selecionada por
preset; override granular só existe com caso operacional documentado.

## 5. Constantes internas

### `CODE_CONSTANT`

São candidatos a constante versionada, não setting:

- doom/fuzzy/dominance windows e tolerâncias;
- read duplicate thresholds/window;
- reducer flush/cumulative/polling/stuck heuristics;
- compaction tail fractions e internal retry caps;
- LRU/pin sizes e search confidence;
- heartbeat/cooldown/throttle internos;
- cache entry size/TTL que não seja quota de tenant;
- salvage/polling/stuck heuristic;
- default preview sizes por content type;
- memo/count limits sem significado de produto.

Se um valor limita recurso físico ou gasto, ele pertence a policy/resource
grant. Se apenas calibra algoritmo interno, é constante.

## 6. Env allowlist

### `BOOTSTRAP_ENV`

Categorias permitidas:

- provider/GitHub credentials enquanto não migradas para secret store;
- root/endpoint/port necessário antes de abrir config store;
- `PROMPTS_WATCH` e debug/trace no desenvolvimento;
- configuração de crash dump/profiling;
- um kill switch fail-closed para incidente;
- seleção temporária do runtime/canário.

Chaves exatas devem morar em um manifesto allowlisted. `CODER_GITHUB_TOKEN` é
segredo/referência, não setting administrativo comum.

## 7. Rollouts temporários

### `ROLLOUT_TEMP`

Inclui famílias `*_SHADOW`, `*_ENFORCE` e `*_ROLLOUT_PERCENT`, por exemplo:

- agent run store/control plane journal;
- capability catalog shadow;
- Policy Engine shadow/enforce durante convergência;
- finish evidence e smart reducer rollout;
- seleção Rust/legacy.

Cada entrada exige:

```text
key / owner / createdAt / expiresAt
hypothesis / metric / promotionGate / rollback
replacement or deletion PR
```

Expiração falha CI. Uma rollout promovida vira default sem flag; uma rollout
rejeitada é removida.

## 8. Mover para domínio responsável

### `MOVE_DOMAIN`

- `MCP_PIPELINES_GRAPH_EXPANSION` -> indexer search profile;
- `MCP_SUPERVISOR_ENABLED` e watchdogs Company -> Company runtime policy;
- `MCP_MEMORY_CONSOLIDATE` e thresholds -> memory service policy;
- docs RAG rewrite/rerank -> docs search profile;
- Git/remote/environment -> environment binding/configuração própria;
- notifications/design system/App Studio -> feature owner, fora do code-run.

Mover não significa manter env. O domínio destino aplica as mesmas regras de
schema, defaults, provenance e expiry.

## 9. Critério de cobertura em P0

O inventory gerado deve falhar se qualquer `CODER_*` ou code-run
`MCP_PIPELINES_*` não se encaixar em exatamente uma classe. Para cada chave:

```text
key
class
target field/constant/removal
consumers
current effective value + provenance
owner
migration phase
deletion gate
```

Este arquivo decide a semântica; o artifact gerado prova exaustividade contra o
código do commit executado.

## 10. Snapshot executado em 2026-08-05

O audit AST examinou 4.186 arquivos e 324 nomes distintos. No caminho de
code-run restaram 15 leituras diretas, todas classificadas, e nenhuma leitura
dinâmica de `process.env`:

- 4 rollouts temporárias com owner, expiry, métrica e rollback receipt;
- 4 entradas de bootstrap/segredo/diagnóstico;
- 7 entradas que pertencem a Company, memory ou indexer e serão retiradas por
  esses domínios.

Qualquer nova leitura code-run não classificada, dinâmica, duplicada ou com
rollout expirada falha `pnpm tsx scripts/audit-env-vars.ts --check`.
