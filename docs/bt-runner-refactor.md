# Behavior Tree Runner Refactor — handoff completo

**Status**: BT é a rota padrão de produção. 174/174 tests passando. Legacy fallback ativo via `CODER_LEGACY_RUNNER=1`. Algumas features avançadas migradas via bridge callbacks; algumas pendentes.

**Quando começou**: maio/2026
**Pasta principal**: `packages/code-agent/src/core/runner/`

---

## 1. Contexto do problema

Em sessões longas (>30 turns), o `code-agent` apresentava 5 sintomas:

1. **Preso em uma tool**: chamava a mesma tool repetidamente sem aprender.
2. **Perdia tools**: depois de muitas mensagens parecia "esquecer" o que tinha.
3. **Compactação destruía o sentido**: o `compactMessages` (char-based legado) substituía `tool_result.content` por marker estático `[compacted: N chars]`. Quando o modelo re-lia o mesmo path, via o marker em vez dos dados → re-executava → loop.
4. **Anti-loop tardio**: `DUP_CALL_THRESHOLD ≈ 5-15` chamadas para disparar. Kimi-CLI faz reminder na **2ª** chamada idêntica.
5. **State machine implícita**: 4994 LOC de `while (turn<maxTurns)` com guards (doom-loop, dominance, polling-stuck, tool-misuse) espalhados, `continue`s aninhados, flags mutáveis. Diagnosticar/estender era cirurgia.

Inspirações: `.reference/kimi-cli` (Python) e `.reference/codex/codex-rs/core` (Rust).

---

## 2. Decisões arquiteturais (confirmadas pelo usuário)

| Decisão | Escolha | Por quê |
|---|---|---|
| **Estrutura do loop** | Behavior Tree (BT) explícita com nós tipados + tabela de transições | Tornar implícito explícito; testável em isolamento; novos guards = novo arquivo |
| **Compactação** | LLM summary preservando últimos 40% intactos, dispara em 90% effective context | Preserva semântica vs marker mudo |
| **Anti-loop** | Tuple-hash dedup ao estilo Kimi (`stableArgsKey`) — 2ª = reminder, 3ª = refuse | Catch precoce em vez de queimar 5+ chamadas |
| **Compatibilidade** | BT default-on com fallback automático ao legacy via `try/catch` | Risco controlado |
| **Disciplina LOC** | Arquivos novos ≤200 LOC, teto absoluto 250 | Regra registrada na memória do user |
| **Fallback de emergência** | `CODER_LEGACY_RUNNER=1` força legacy | Escape hatch em produção |

---

## 3. Arquitetura nova — `packages/code-agent/src/core/runner/`

Total: **~4042 LOC em 36 arquivos** (não incluindo tests).

```
runner/
├── orchestrator.ts                 (149)  loop principal: state = nextState(state, await node.execute(ctx))
│                                          while + try/finally; recoverStaleTasks no shutdown.
│
├── machine/                              ── ESTADO DA MÁQUINA
│   ├── types.ts                    (~195)  NodeState | BehaviorEvent | BehaviorNode | RunContext | BridgeCallbacks
│   ├── transitions.ts               (86)   TRANSITIONS table + nextState() puro
│   ├── context.ts                  (105)   createRunContext, ensureBootstrap, bumpRecovery, accumulateUsage
│   ├── events.ts                    (42)   factories: events.turnSucceeded(), events.tokenThresholdHit(), …
│   └── __tests__/transitions.test.ts      10 tests — combinatória, terminalidade
│
├── nodes/                                ── ESTADOS (7 nós + helpers)
│   ├── bootstrap.ts                 (40)   Bootstrap → emit run_started, invariante bootstrap tier
│   ├── executing.ts                (~290)  loop core: pre-think → provider.chat (heartbeat) → push → dispatch → quality → decide
│   ├── executing-stream.ts         (193)   consumer puro do AsyncIterable<ChatDelta> — só usa tool_call_end (id final)
│   ├── executing-dispatch.ts       (~270)  dispatch serial — gate chain + heartbeat + smart-reducer + polling-stuck
│   ├── executing-decisions.ts      (101)   decideTerminal (max-turns/auto-continue), runQualityCheck, helpers
│   ├── planning.ts                  (45)   forced plan turn após ToolLoopDetected — reset dupCalls
│   ├── compacting.ts               (137)   LLM compactor — chama summarizeSpanV2, preserva últimos 40%
│   ├── reviewing.ts                 (34)   pós-compactação — re-asserta invariantes
│   ├── recovering.ts                (91)   retry/refresh/abort com circuit breaker per kind
│   ├── done.ts                      (19)   terminal sentinel (nunca invocado)
│   └── __tests__/*.test.ts                bootstrap, recovering, compacting, reviewing, planning, executing
│
├── guards/                               ── GUARDAS PUROS
│   ├── tuple-hash-dedup.ts         (137)  Kimi-style — 2ª call = reminder, 3ª = refuse
│   ├── doom-loop.ts                (107)  rollback legacy de assinaturas cross-turn
│   ├── max-turns.ts                 (42)  limit + auto-continue (default 3)
│   ├── task-mode-gate.ts            (80)  refuse write tools quando all-subagent + tasks pending
│   └── __tests__/*.test.ts                9+6+5+9 tests
│
├── compaction/                           ── LLM COMPACTOR
│   ├── threshold.ts                 (73)  shouldCompact90 + computeProtectTokens (40% effective)
│   ├── llm-compactor.ts            (135)  cutoff + recede-last-N-turns + snap-pairs + summarize + splice
│   ├── summary-renderer.ts          (28)  CompactionSummaryV2 → AgentMessage user
│   └── __tests__/*.test.ts                threshold, llm-compactor, summary-renderer
│
├── assembly/                             ── PER-TURN ASSEMBLY (extraído do legacy)
│   ├── messages.ts                  (80)  assembleMessagesForChat
│   ├── tools.ts                    (177)  buildTools (tier filter + essentials partition + truncate)
│   └── system-prompt.ts             (24)  placeholder
│
├── (puros / migrados do legacy)
│   ├── constants.ts                (203)  DUP_CALL_THRESHOLD, POLLING_STUCK_CAP, REPEATABLE_NAME_PATTERN…
│   ├── dup-utils.ts                (119)  stableArgsKey, hashShort, previewToolArgs
│   ├── signatures.ts                (40)  toolCallsSignature, toolNamesSignature
│   ├── markers.ts                  (190)  buildDupReminderMarker, buildPollingStuckRefusal…
│   ├── intervention.ts              (61)  classifier-streak nudge text
│   ├── provider-retry.ts            (61)  backoffDelayMs, nonRetryableProviderErrorReason
│   ├── recovery-config.ts          (104)  RECOVERY_KINDS + caps + preserveLastNTurns
│   ├── pure-helpers.ts              (79)  filterGoalToolsByState, approxChars, shouldSpillToolOutput
│   ├── company-essentials.ts        (57)  isEssentialCompanyTool
│   ├── events.ts                   (371)  RunnerEvents type — TODOS os eventos emitidos
│   └── types.ts                    (192)  RunnerOptions, RunResult, StopReason, TransitionKind
│
└── __tests__/                              174 testes (21 arquivos) — tudo verde
```

### Fluxo principal de estados

```
Bootstrap → Executing ⇄ Executing                    (loop normal)
              ↓ TokenThresholdHit (90% effective)
           Compacting → Reviewing → Executing
              ↓ ToolLoopDetected (tuple-hash 3ª call)
           Planning → Executing                       (reset dupCalls)
              ↓ ProviderError
           Recovering → Executing                     (backoff exp+jitter)
              ↓ CleanFinish | MaxTurnsReached | Aborted
           Done
```

A **transition table** em [transitions.ts](../packages/code-agent/src/core/runner/machine/transitions.ts) é `Record<NodeState, Partial<Record<EventKind, NodeState>>>` — testes em [transitions.test.ts](../packages/code-agent/src/core/runner/machine/__tests__/transitions.test.ts) validam combinatória completa.

---

## 4. Histórico cronológico (PRs/commits)

Cada item foi 1 task fechada. Tudo entregue com testes verdes ao final.

### Commit 1 — Esqueleto BT atrás de flag
`machine/types.ts`, `transitions.ts`, `context.ts`, `orchestrator.ts` + stubs em `nodes/*`. Atrás de `CODER_BT_ENABLED`. Loop legado intocado. **10 tests** de combinatória da tabela.

### Commit 2 — Assembly extraído
`assembleMessagesForChat`, `buildTools`, `buildToolsCacheKey` migrados de `runner.ts` (closures) para `assembly/*.ts` (funções puras). Wrappers delegam mantendo assinatura. **−104 LOC** no runner.ts. Comportamento byte-idêntico.

### Commit 3 — Bootstrap + Recovering reais
`Bootstrap` emite `run_started` + invariante de tier. `Recovering` classifica 401/400/5xx, bumpa counter, exp+jitter backoff, abort no cap via `recovery_aborted` event. Executing/Compacting/Planning/Reviewing/Done permaneceram stubs nesse commit.

### Commit 4 — LLM compactor + Compacting + Reviewing
`compaction/threshold.ts` (`shouldCompact90`), `summary-renderer.ts` (CompactionSummaryV2 → AgentMessage), `llm-compactor.ts` (cutoff + recede-last-N-turns + snap-pairs + summarize). Reusa `summarizeSpanV2` + `renderSummaryV2` existentes. Compacting chama compactor; Reviewing valida invariantes pós.

### Commit 5 — Guards + Planning
`tuple-hash-dedup.ts` (guard local por invocation/epoch), `no-progress.ts` (shadow pós-resultado), `doom-loop.ts` (rollback legacy) e `max-turns.ts`. PlanningNode real — limpa apenas o estado legacy e registra `ctx.transition`.

### Commit 6 — Executing real
`executing-stream.ts` (consumer puro), `executing-dispatch.ts` (dispatch serial + guards), `executing.ts` (orquestra). Cobre happy path + token threshold + tool loop detection. Features avançadas faltantes: documentadas.

### Commit 7 — BT default-on + fallback
`isBehaviorTreeEnabled()` retorna `process.env.CODER_LEGACY_RUNNER !== '1'`. `CoderRunner.runViaBehaviorTree()` privado: bridge ao `EventEmitter` legado para que listeners SSE/CLI continuem recebendo eventos. Fallback automático ao legacy se BT throw.

### Bridge callbacks (features faltantes via bridge, não migração)
[machine/types.ts](../packages/code-agent/src/core/runner/machine/types.ts) `BridgeCallbacks` ganhou hooks: `buildActiveSkillsBlock`, `buildActiveContextBlock`, `buildQualityFeedbackSuffix`, `resolveTemperature`, `getPreviousResponseId`, `onResponseId`, `toolGate`, `enforcePreRead`, `reduceToolResult`, `detectPollingStuck`, `runPreThink`, `runQualityCheck`, `enforceTaskMode`. Implementados em `runner.ts:runViaBehaviorTree()` delegando para métodos privados existentes da `CoderRunner`. **`activeTiers` virou `Set<ToolTier> | null`** (null = no filter) — sem isso MCPs externos sumiam dos subagents.

### Spawn agent regression + tiered permissions
**Bug**: `openai.ts` provider emitia `tool_call_start` com placeholder id (`tool_${idx}`) e o ID real só chegava em `tool_call_end`. BT criava `tu` na chave errada → input perdido → toolUses vazio → CleanFinish imediato.

**Fix**: BT [executing-stream.ts](../packages/code-agent/src/core/runner/nodes/executing-stream.ts) agora **ignora completamente** `tool_call_start`/`tool_call_args` (igual o legacy [runner.ts:5022-5024](../packages/code-agent/src/core/runner.ts:5022)). Cria o tool_use só em `tool_call_end` (autoritativo).

**Tiered permissions**:
- `READ_ONLY_FILTER` = `EXPLORE_ALLOWLIST` ∪ MCP externos `mutates:false`
- `READ_WRITE_FILTER` = `IMPLEMENT_ALLOWLIST` ∪ `EXPLORE_ALLOWLIST` ∪ TODAS MCP externos
- `FULL_ACCESS_FILTER` = `null` (parent registry inteiro)
- `VERIFY_FILTER` = reads + run_command + lsp_diagnostics (NOVO em PR 3)

`SubagentSpec.allowlist` agora aceita `Set<string> | (tool) => boolean | null`.

### Eventos faltantes do BT pro dashboard
Adicionados em `executing.ts` + `executing-dispatch.ts`:
- `provider_call` (antes da chamada)
- `tool_batch` (preview do batch)
- `tool_call_start` (real ID, antes do invoke)
- `tool_call_finalized` (após smart-reducer + polling-stuck shaping)

### Unificação spawn tools (3 fases)
**Antes**: `spawn_subagent`, `spawn_agents`, `spawn_agent` (wrapper) + `spawn_subordinate_agent` (master-only).
**Depois**: 1 tool — `spawn_agent({ agents: [{ task, type?, label?, max_turns?, files? }, ...], parallel?, kind? })`.

- 1 item → `runSubagent` sequencial
- 2-8 items → `runParallelAgents` paralelo (auto)
- `type: 'explore' | 'implement' | 'full'`
- `kind: 'ephemeral' | 'persistent'` (persistent = master company)
- Backward compat: `task` singular auto-wrap em `agents:[{task}]`

`spawn_subagent` e `spawn_agents` deletadas. `spawn_subordinate_agent` permanece separada (semântica company distinta).

### Bug A — `spawn_agent` no tier ERRADO
Estava em `NAVIGATE_TOOLS` ([tiers.ts:149](../packages/code-agent/src/tools/tiers.ts:149)). Movido para `BOOTSTRAP_TOOLS` junto com `expand_toolset`/`find_tools`. Sessão sem navigate tier desbloqueado agora consegue delegar.

### Bug B — `find_tools` ranking
Ranking lexical puro sem score mínimo retornava noise (`enter_worktree`, `expand_toolset`) para queries como "spawn_agent parallel agents".

Fix em [find-tools.ts](../packages/code-agent/src/tools/find-tools.ts):
- Tokenizer quebra por `[^a-z0-9]+` (inclui underscore) — `"spawn_agent"` vira `["spawn", "agent"]`
- **Snake_case part-aware**: whole-part match `+4`, substring fallback `+2`, desc `+1`
- **Min score proporcional**: 1 token → `3`; N tokens → `max(3, ceil(N * 1.5))`
- **Floor pure-description**: `nameScore===0 → exige descScore >= 2`
- Env override: `CODER_FIND_TOOLS_MIN_SCORE_RATIO`
- **7 testes novos** em `find-tools.test.ts` (primeiro coverage do find_tools)

> **Superado (jul/2026)**: o scorer acima tornava match puro de descrição
> matematicamente impossível (máx. `N` pontos vs. threshold `ceil(N*1.5)`) e
> não buscava nomes de argumentos. Substituído pelo scorer de 2 passes em
> `find-tools-score.ts` (nome + params top-level + palavras de descrição,
> coverage-based). Env `CODER_FIND_TOOLS_MIN_SCORE_RATIO` → substituído por
> `CODER_FIND_TOOLS_MIN_COVERAGE` (default `0.5`).

### Heartbeats (4 camadas)

| Camada | Onde | Quando | Period | Env |
|---|---|---|---|---|
| **1** | [executing-dispatch.ts](../packages/code-agent/src/core/runner/nodes/executing-dispatch.ts) | durante `registry.invoke()` | 10s | param `toolProgressIntervalMs` |
| **2** | [implement-subagent.ts:runParallelAgents](../packages/code-agent/src/tools/implement-subagent.ts) | durante `Promise.all` | 15s | `CODER_PARALLEL_HEARTBEAT_MS` |
| **3** | [executing.ts](../packages/code-agent/src/core/runner/nodes/executing.ts) | durante `await consumeStream` | 10s | `CODER_STREAM_HEARTBEAT_MS` |
| **4** | [executing.ts](../packages/code-agent/src/core/runner/nodes/executing.ts) | durante `await bridge.runPreThink` | 10s | `CODER_PRE_THINK_HEARTBEAT_MS` |

Camada 1 suprime para `tool.interactive === true` ou `tool.timeoutMs === Infinity` (esperas legítimas).

Todos limpam em `try/finally`. Reseta `lastEventAt` no SSE do master → StuckBanner não dispara em esperas legítimas.

### Task-mode gate
Novo guard puro em [guards/task-mode-gate.ts](../packages/code-agent/src/core/runner/guards/task-mode-gate.ts). Quando user aprova `submit_tasks` com `execution_mode='all-subagent'`, este guard refusa tools mutating não-workflow para forçar uso de `execute_task`/`execute_tasks`. Wire no `executing-dispatch.ts` ANTES do tuple-hash.

`WORKFLOW_TOOLS` allowlist: `execute_tasks`, `execute_task`, `task_complete`, `update_task`, `submit_tasks`, `spawn_agent`, `ask_user`, `submit_plan`, `find_tools`, `expand_toolset`.

### Fix deepthink hang
**Bug**: `resolveAuxProvider` SEM timeout — primeira chamada de deepthink hangava em OAuth refresh do ChatGPT/Codex. PIOR: `pre_think_started` era emitido DEPOIS do `await resolveAuxProvider`, então o stall era silencioso.

Fixes em [runner.ts:runAuxiliaryPreThink](../packages/code-agent/src/core/runner.ts):
- Timeout em `resolveAuxProvider` (default 15s, env `CODER_AUX_PROVIDER_TIMEOUT_MS`)
- `pre_think_started` emit ANTES de qualquer await
- Camada 4 envolve toda `bridge.runPreThink()`

### PR 1 — Workflow de tasks (3 fixes)
1. **Diagnostic logs** `[coder/tasks]` em `submit_tasks` (`execution_mode` recebido vs persistido) e `execute_task` (state lido + effective resolvido).
2. **`recoverStaleTasks` no shutdown do BT** — orchestrator em `try/finally` chama `store.recoverStaleTasks(sessionId)`. Tasks `running` órfãs viram `interrupted` ao final de qualquer run.
3. **Subagent events propagation** — `subRunner.on('tool_progress', ...)` em `runSubagent` E `runParallelAgents` repropaga ao parent com prefix `[subagent]` / `[parallel <label>]`. Acabou a "caixa preta" do `spawn_agent`.

### PR 2 — Schema novo do `CoderTask`
[sessions/types.ts](../packages/code-agent/src/sessions/types.ts) — `CoderTask` ganhou:
```ts
kind?: 'investigate' | 'implement' | 'verify'  // default 'implement'
parallel_group?: string                         // mesmo group + sem mutual dep = paralelo
```
Validador em [tools/tasks.ts](../packages/code-agent/src/tools/tasks.ts) aceita ambos. JSON schema do `submit_tasks` documenta. Backward compat preservada (tasks antigas sem `kind` viram `'implement'`).

### PR 3 — `execute_tasks` orquestrador wave-based
[tools/execute-tasks.ts](../packages/code-agent/src/tools/execute-tasks.ts) — NOVO (~290 LOC).

Algoritmo:
```
buildWaves(tasks)            // topological sort respeitando depends_on
  ↓ for each wave:
groupByParallel(wave)        // agrupar por parallel_group
  ↓ for each group:
  length === 1 → runSubagent (per kind)
  length > 1   → runParallelAgents (per-spec types)
  ↓ update task status → próxima wave
```

Per-kind dispatch:
- `investigate` → `READ_ONLY_FILTER` + `EXPLORE_SYSTEM_PROMPT`
- `implement` → `READ_WRITE_FILTER` + `IMPLEMENT_SYSTEM_PROMPT` + pathScope=task.files
- `verify` → `VERIFY_FILTER` (novo) + `VERIFY_SYSTEM_PROMPT` (novo)

Modos: `auto` (default, subagent per kind) | `inline-all` (legacy escape hatch).

Registrada em `BOOTSTRAP_TOOLS`. `formatTasksApprovedResult` recomenda como **PREFERRED**. `execute_task` (singular) mantido como fallback.

---

## 5. Sumário de bugs encontrados e fixes

| Bug | Sintoma | Causa | Fix |
|---|---|---|---|
| Tool_call ID mismatch | `spawn_agent` retornava imediato em sessão real | `openai.ts` emite `tool_call_start` com placeholder id; ID real só em `tool_call_end`. BT chave-mismatch | `executing-stream.ts` ignora start/args, cria tu só em `tool_call_end` |
| spawn_agent tier errado | tool não visível sem `expand_toolset('navigate')` | Substituí `spawn_subagent/spawn_agents` por `spawn_agent` na lista de NAVIGATE em vez de mover pra BOOTSTRAP | Mover pra BOOTSTRAP_TOOLS |
| find_tools ranking ruim | "spawn_agent parallel agents" trazia `enter_worktree`/`expand_toolset` | Score lexical puro sem floor, name vs description sem peso | Score mínimo proporcional + snake-aware + floor desc |
| Worker idle stall | Banner amarelo durante operações legítimas longas | Sem heartbeat em await consumeStream / runParallelAgents / bridge.runPreThink | 4 camadas de heartbeat |
| Deepthink hang silencioso | Sessão travava sem evento visível | `resolveAuxProvider` sem timeout; emit `pre_think_started` DEPOIS do await | Timeout + emit antecipado + Camada 4 |
| Compactação semanticamente vazia | Agente re-lia mesmo path, via marker, re-executava | char-based `[compacted: N chars]` mudo | LLM compactor preservando últimos 40% |
| Tasks órfãs `running` | Painel mostrava spinner fantasma após session end | `recoverStaleTasks` só no resume da próxima sessão | Cleanup também no shutdown do BT (try/finally) |
| Subagent caixa preta | `spawn_agent running 564s` sem progresso visível | Sub-runner não propagava events | Re-emit `tool_progress`/`tool_call_result` ao parent |
| execute_task em mode wrong | Modo `all-subagent` abria scope inline | Provavelmente race ou state desincronizado (logs adicionados pra capturar) | Logs `[coder/tasks]` ativos + recomendar `execute_tasks` (PR 3) |

---

## 6. Workflow de tasks reformulado

### Antes (fraco)
- Modelo chamava `execute_task(id)` task-a-task
- `suggested_mode` binário (inline/subagent)
- Sem suporte a paralelismo verdadeiro
- Tools mutating diretas eram permitidas → user mode `all-subagent` ignorado

### Depois (PRs 2 + 3)
```ts
submit_tasks({
  summary: "Refactor X",
  tasks: [
    { id:'t1', kind:'investigate', title:'Map callers', ...},
    { id:'t2', kind:'implement', files:['src/a.ts'], depends_on:['t1'], parallel_group:'extract' },
    { id:'t3', kind:'implement', files:['src/b.ts'], depends_on:['t1'], parallel_group:'extract' },
    { id:'t4', kind:'verify', depends_on:['t2','t3'] },
  ]
})
// → user aprova com execution_mode 'all-subagent' (ou 'auto')

execute_tasks()
// → wave 1: [t1]                    (investigate subagent read-only)
//   wave 2: [t2, t3] paralelo       (2 implement subagents concurrent)
//   wave 3: [t4]                    (verify subagent: run_command + lsp)
// → retorna summary consolidado
```

`task-mode-gate` em modo `all-subagent` refusa writes diretos do master → forcing uso de `execute_tasks`.

---

## 7. Variáveis de ambiente (env vars)

### Comportamento principal
| Env | Default | Função |
|---|---|---|
| `CODER_LEGACY_RUNNER` | `''` (BT on) | `=1` força while-loop legacy, desliga BT |
| `CODER_BT_DEBUG` | `''` (off) | `=1` ativa logs `[bt-debug]` em Bootstrap/Executing |

### Heartbeats / timeouts
| Env | Default | Função |
|---|---|---|
| `CODER_STREAM_HEARTBEAT_MS` | `10000` | Camada 3 — heartbeat durante `provider.chat()` |
| `CODER_PARALLEL_HEARTBEAT_MS` | `15000` | Camada 2 — heartbeat durante `runParallelAgents` |
| `CODER_PRE_THINK_HEARTBEAT_MS` | `10000` | Camada 4 — heartbeat durante `bridge.runPreThink` |
| `CODER_STREAM_IDLE_TIMEOUT_MS` | `90000` | Idle timeout do `consumeStream` |
| `CODER_AUX_PROVIDER_TIMEOUT_MS` | `15000` | Timeout em `resolveAuxProvider` (deepthink) |

### Compactação
| Env | Default | Função |
|---|---|---|
| `CODER_COMPACT_PROTECT_RATIO` | `0.30` | Cauda mantida verbatim (fração da janela em TOKENS); subiu de 0.15 |
| `CODER_COMPACT_MIN_TAIL_TURNS` | `8` | Piso por contagem — mínimo de turnos renderizáveis (user+assistant) sempre na cauda, mesmo com tail denso em tokens |
| `CODER_COMPACT_MIN_TAIL_FRACTION` | `0.10` | Piso fracionário — fração dos turnos renderizáveis visíveis; piso efetivo = max(turns, ceil(fração×total)) |
| `CODER_COMPACT_PRESERVE_LAST_N_TURNS` | `2` | Kimi-style — tail de N user turns sempre intacto |
| `CODER_COMPACT_RECEDE_TAIL_RATIO` | `0.50` | Teto do recede (fração da janela) — limita o quão grande a cauda cresce, abaixo do trigger |
| `CODER_PRUNE_MINIMUM` | `60000` | (legado char-based) — só usado quando char path roda |
| `CODER_PRUNE_PROTECT` | `80000` | (legado char-based) |

### Find_tools
| Env | Default | Função |
|---|---|---|
| `CODER_FIND_TOOLS_MIN_COVERAGE` | `0.5` | Fração de tokens da query que precisam acertar no passe forte (`hitCount >= ceil(N * coverage)`); substituiu `CODER_FIND_TOOLS_MIN_SCORE_RATIO` |

### Recovery circuit breakers
| Env | Default | Função |
|---|---|---|
| `CODER_RECOVERY_400_MAX` | `3` | Limite de retries de 400 |
| `CODER_RECOVERY_401_MAX` | `2` | Limite de refresh de auth |
| `CODER_RECOVERY_TRANSIENT_MAX` | `30` | Limite de 429/5xx |
| `CODER_RECOVERY_FALLBACK_MAX` | `5` | Limite de fallback de provider |
| `CODER_RECOVERY_COMPACT_MAX` | `3` | Limite de compactação consecutiva falhada |

### Doom-loop / dup-call (legado, ainda relevante)
| Env | Default | Função |
|---|---|---|
| `CODER_DOOM_LOOP_THRESHOLD` | `3` | Rollback legacy — N turns idênticos consecutivos |
| `CODER_DOOM_LOOP_FUZZY_THRESHOLD` | `6` | Rollback legacy — N turns com mesmo conjunto de nomes |
| `CODER_DEDUP_POLICY` | `hybrid` | `hybrid` local seguro, `observe` shadow, `legacy` rollback temporário |

---

## 8. Logs importantes

Filtros de `grep` úteis pra diagnosticar produção:

```
[coder/bt]          # BT lifecycle: node transitions, run start/done
[coder/tasks]       # Workflow de tasks: submit_tasks, execute_task, execute_tasks
[bt-debug]          # Debug detalhado quando CODER_BT_DEBUG=1
[coder]             # Logs originais do legacy + alguns no BT path
```

Eventos críticos:
- `[coder/bt] node=<X> turn=<N>` — entrada em cada nó
- `[coder/bt] node=<X> → event=<Y>` — transição
- `[coder/bt] done runId=<...> reason=<X>` — fim
- `[coder/tasks] submit_tasks approved — execution_mode=<X> (received=<Y>)` — diagnóstico de state lost
- `[coder/tasks] execute_task task_id=<X> state.execution_mode=<Y> → effective=<Z>` — diagnóstico de dispatch
- `[coder] compaction pruned <N> tool_result blocks (~<X> chars)` — char compactor legacy ativo

---

## 9. Como rodar e testar

```bash
# Build + typecheck do package
npx tsc --noEmit -p packages/code-agent

# Suite de tests do core+tools (target de testes do BT)
npx vitest run packages/code-agent/src/core packages/code-agent/src/tools

# Suite completa do code-agent
npx vitest run packages/code-agent

# Disciplina de LOC (regra do user — registrada na memória)
npm run check:loc

# Forçar legacy pra comparar
$env:CODER_LEGACY_RUNNER="1"; npm run dev:server

# Debug detalhado do BT
$env:CODER_BT_DEBUG="1"; npm run dev:server
```

Estado atual: **174/174 tests passando, 21 arquivos**.

Issues conhecidas em outros packages (não relacionadas ao BT):
- `packages/skills/src/prompt-injector.ts` — erros de tipo TS2339 pré-existentes
- `apps/http-api/sse/*` — TS6059/TS6307 de config monorepo
- `packages/code-agent/src/tools/__tests__/shadow-variants.test.ts` — 2 falhas de `better-sqlite3 NODE_MODULE_VERSION` (resolve com `npm run node:rebuild`)

---

## 10. O que NÃO foi migrado / pendências

### Features que ainda usam o legacy fallback automaticamente

Estes ficam no `CoderRunner` legacy e são acessados via fallback `try/catch` quando BT não cobre. Em sessões normais isso não vira problema porque o BT cobre a esmagadora maioria; mas se o caso de uso depende muito de algum desses, force `CODER_LEGACY_RUNNER=1`.

| Feature | Status no BT | Onde mora hoje |
|---|---|---|
| Deep-think pre-think | ✅ via bridge | `runner.ts:runAuxiliaryPreThink` (private) |
| Polling-stuck cap | ✅ via bridge | `bridge.detectPollingStuck` |
| Pre-read enforcement | ✅ via bridge (Layer 1 simplificada) | `bridge.enforcePreRead` — só refuse, faltam layers 2-4 (mutation-since, elided, auto-downgrade) |
| Smart-reducer pós-result | ✅ via bridge | `bridge.reduceToolResult` |
| Polling-stuck detector | ✅ via bridge | `bridge.detectPollingStuck` |
| Quality watchdog | ✅ via bridge | `bridge.runQualityCheck` → `maybeRunWatchdog` |
| Auto-continue (>maxTurns) | ✅ no BT direto | `executing-decisions.ts:decideTerminal` |
| Worktree scope mid-session | ✅ funciona via `ctx.toolContext.cwd` shared | sem hook explícito |
| Plan/spec mode gate | ✅ via bridge | `bridge.toolGate` (mutates check) |

### Itens "kill char path" não removidos

Por segurança (BT ainda usa via `assembly/messages.ts → compactHistoryForLLM` no caminho de cada turn):
- `compactMessages` (`core/compaction.ts:113-175`) — substitui tool_result por marker. Ativa a cada turn quando histórico cresce.
- `PRUNE_MINIMUM`, `PRUNE_PROTECT`, `deriveCompactionLimits`, `computeCompactionTrigger` em `compaction/limits.ts`

Para realmente matar isso é preciso:
1. Validar que LLM compactor cobre 100% dos casos (atualmente só dispara em 90% effective context)
2. Reduzir threshold do LLM compactor (e.g. 75%) para que ele cubra cedo
3. Remover o char path e os env vars associados

Ver "Bomba de compactação" — char compactor pruna ~669k chars em sessões longas a cada turn. É barulho mas FAZ trabalho real; não é seguro remover sem ter LLM compactor disparando antes.

### Tests faltantes

- `tools/execute-tasks.ts` — `buildWaves` e `groupByParallel` são funções puras, fáceis de testar. Sugestão: 6-10 testes (~150 LOC).
- Integration test de `runViaBehaviorTree` com mock provider — único caminho que ainda só tem smoke tests.

### Frontend / UX

- `TaskRow.tsx` — não mostra `kind` ainda. Badge com cor (read=cinza, write=verde, verify=azul) seria fácil add.
- `TaskListReview.tsx` — ainda envia os 4 modes legacy (`inline/all-subagent/smart/per-task`). Backend aceita ambos sem mudar comportamento. Migrar para `auto/inline-all` é cosmetic.
- Wave preview no painel — mostrar "Wave 1 of 3" durante execução; consome `agents_group_start`/`agents_group_end`.

### Cleanup eventual

- `runner.ts` ainda tem **~4900 LOC**. Quando legacy for matado:
  - Remover while-loop legacy (~1500 LOC)
  - Reduzir `CoderRunner` para facade puro (~300 LOC)
  - DB migration: drop `phase_profile_id`, `previous_response_id*` (atualmente populated mas ignored)

---

## 11. Estado dos sub-agentes (decisão arquitetural importante)

Existem 2 tools de spawn no final:

1. **`spawn_agent`** — ÚNICA tool ephemeral para qualquer sessão.
   - Schema: `{ agents: [{task, type, label?, max_turns?, files?}, ...], parallel?, kind? }`
   - 1 item = sequencial, N items = paralelo (auto até 8)
   - `type: 'explore' | 'implement' | 'full'`
   - `kind: 'ephemeral'` (default) ou `'persistent'` (delega a `spawn_subordinate_agent`)
   - Backward compat: `task` singular wraps em `agents:[{task}]`

2. **`spawn_subordinate_agent`** — master-only company.
   - Schema: `{ role, task, project_id?, provider?, model?, tier?, skills?, kanban_card_id?, wait?, forward_user_attachments? }`
   - Cria sessão coder completa com kanban/board/wait
   - **Não unificado intencionalmente** — semântica de "sessão coder filha" é fundamentalmente diferente de "subagent inline"

Allowlists em [implement-subagent.ts](../packages/code-agent/src/tools/implement-subagent.ts):
- `EXPLORE_ALLOWLIST` (Set fixo legado)
- `IMPLEMENT_ALLOWLIST` (Set fixo legado)
- `READ_ONLY_FILTER` (predicate: explore allowlist + MCPs read-only)
- `READ_WRITE_FILTER` (predicate: implement allowlist + explore + TODOS MCPs)
- `FULL_ACCESS_FILTER` (null = sem filter)
- `VERIFY_FILTER` (predicate: reads + run_command + lsp)

---

## 12. Como continuar o trabalho

### Se for adicionar uma nova feature ao BT
1. Definir se é estado novo (raro — adicionar nó em `nodes/`) ou comportamento (comum — adicionar guard em `guards/` OU bridge callback em `machine/types.ts:BridgeCallbacks`).
2. Se guard: pattern de `tuple-hash-dedup.ts` ou `task-mode-gate.ts` — função pura, retorna decisão, wire no `executing-dispatch.ts`.
3. Se bridge: adicionar tipo em `BridgeCallbacks`, implementar em `runner.ts:runViaBehaviorTree()` delegando ao legacy ou nova função.
4. Adicionar tests em `guards/__tests__/` ou `nodes/__tests__/`.

### Se for migrar mais coisa do legacy
- Identifica método privado em `runner.ts`
- Cria função pura em `runner/` subfolder
- Adiciona bridge callback OU integra direto no nó apropriado
- Wrapper em `runner.ts` (legacy) chamando a função pura — preserva 2 caminhos

### Se for matar o legacy de vez
- Pré-requisito: validar em produção que BT cobre tudo
- Remove `try/catch` fallback em `CoderRunner.run()` (linha ~2440)
- Remove while-loop body inteiro
- Reduz `CoderRunner` a facade puro chamando `runBehaviorTree(...)`
- Remove `compactMessages`, `PRUNE_*`, `deriveCompactionLimits`, `computeCompactionTrigger`
- DB migration: drop colunas legadas

### Comandos úteis pra exploração
```bash
# Onde algo é referenciado
grep -r 'spawn_agent' D:/MCP/packages/code-agent/src

# Quem chama um método
grep -r 'runViaBehaviorTree\|bridge\.runPreThink' D:/MCP

# Listar todos os nodes
ls D:/MCP/packages/code-agent/src/core/runner/nodes/

# Ver eventos disponíveis
grep -A 3 'export interface RunnerEvents' D:/MCP/packages/code-agent/src/core/runner/events.ts
```

---

## 13. Glossário rápido

- **BT** = Behavior Tree. State machine declarativa com nós tipados e transições explícitas.
- **Bridge** = callback que conecta o BT a métodos privados do `CoderRunner` legado. Permite features avançadas sem reimplementar.
- **Tuple-hash dedup** = anti-loop precoce (2ª chamada idêntica = reminder, 3ª = refuse) inspirado em Kimi.
- **LLM compactor** = sumarização semântica via aux model, preserva últimos 40% intactos. Dispara em 90% effective context.
- **Wave** = grupo de tasks com todas as dependências resolvidas, dispatchadas juntas.
- **`parallel_group`** = label para tasks concurrent dentro de uma wave.
- **Camada N** = N-ésima posição da cadeia de heartbeats (1=tool invoke, 2=runParallelAgents, 3=consumeStream, 4=pre-think).
- **READ_ONLY_FILTER / READ_WRITE_FILTER / VERIFY_FILTER / FULL_ACCESS_FILTER** = predicates de allowlist por tipo de subagent.
- **Workflow tools** = tools que SEMPRE passam o task-mode-gate (execute_tasks, submit_plan, find_tools, etc.).

---

## 14. Referências rápidas

| Arquivo | Função |
|---|---|
| [packages/code-agent/src/core/runner.ts](../packages/code-agent/src/core/runner.ts) | Legacy `CoderRunner` class + `runViaBehaviorTree` + bridge |
| [packages/code-agent/src/core/runner/orchestrator.ts](../packages/code-agent/src/core/runner/orchestrator.ts) | BT main loop |
| [packages/code-agent/src/core/runner/machine/types.ts](../packages/code-agent/src/core/runner/machine/types.ts) | Types da máquina |
| [packages/code-agent/src/core/runner/nodes/executing.ts](../packages/code-agent/src/core/runner/nodes/executing.ts) | Core do turn |
| [packages/code-agent/src/tools/spawn-agent.ts](../packages/code-agent/src/tools/spawn-agent.ts) | Spawn unificado |
| [packages/code-agent/src/tools/execute-tasks.ts](../packages/code-agent/src/tools/execute-tasks.ts) | Wave-based orchestrator |
| [packages/code-agent/src/tools/implement-subagent.ts](../packages/code-agent/src/tools/implement-subagent.ts) | runSubagent + runParallelAgents + filters |
| [packages/code-agent/src/tools/tiers.ts](../packages/code-agent/src/tools/tiers.ts) | BOOTSTRAP_TOOLS / NAVIGATE_TOOLS / ADMIN_TOOLS / MASTER_TOOLS |
| [packages/code-agent/src/sessions/types.ts](../packages/code-agent/src/sessions/types.ts) | CoderTask, TasksState, TaskKind |
| [apps/dashboard/features/chat/StuckBanner.tsx](../apps/dashboard/features/chat/StuckBanner.tsx) | Banner amarelo (consumido por SSE) |
| [apps/http-api/sse/runnerWiring.ts](../apps/http-api/sse/runnerWiring.ts) | Forwarding runner events → SSE bus |
| [apps/http-api/workers/coder-worker.ts](../apps/http-api/workers/coder-worker.ts) | Worker subprocess que hospeda CoderRunner |

---

## 15. Validação final

```
$ npx vitest run packages/code-agent/src/core packages/code-agent/src/tools
Test Files  21 passed (21)
Tests       174 passed (174)
```

Sem regressões. BT é o caminho ativo em produção (default-on desde Commit 7). Legacy continua disponível como fallback automático + via `CODER_LEGACY_RUNNER=1` manual.
