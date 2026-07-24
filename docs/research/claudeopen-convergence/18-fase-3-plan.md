# 18 — Plano da Fase 3: AgentRun durável, workflows e Ultra ortogonal

## Status

Documento de contexto durável para a Fase 3. **Referencia o roadmap
([15-roadmap-phases-gates.md](./15-roadmap-phases-gates.md) §7, linhas 301-395),
não o substitui** — em caso de conflito, o roadmap e o `DECISIONS.md` prevalecem.
Escrito após a conclusão das Fases 1 (contratos + journal shadow), 1-alignment
(migration 252, comparator) e 2/2.5 (Policy Engine shadow + composição), para que
o contexto do que JÁ EXISTE não se perca entre sessões.

## 1. Objetivo

Transformar agentes/background/workflows em unidades retomáveis e explicar o
preset Ultra por dimensões (`15:303-305`). Em termos concretos:

- um `AgentRun` sobrevive a crash/restart do processo com exatamente uma
  executor lease vigente;
- foreground e background compartilham o MESMO run/lifecycle — `waitMode` só
  controla o caller (D-008);
- workflows DAG persistem steps/attempts e nunca relançam um step completed
  após restart;
- um verifier read-only seletivo roda dentro do lifecycle comum, antes do
  terminal persistido;
- "Ultra" vira um preset de dimensões separadas (effort, scheduler,
  parallelism, depth, verifier, background, durability, isolation) com
  requested/effective e downgrade reasons auditáveis.

## 2. Estado atual construído (o que a Fase 3 REUTILIZA)

A fundação da Fase 3 já existe parcialmente. Nada abaixo precisa ser recriado —
apenas estendido:

### Persistência (migration 251)

- `agent_runs` — hierarchy (`owner_agent_run_id`/`parent_agent_run_id`/
  `spawn_depth`), role/agent_definition, requested/effective provider/model/
  effort/preset, `downgrade_reasons_json`, `capability_set_ref`,
  `environment_id`, `workspace_lease_id`, refs de preset/policy/transcript/
  checkpoint/result, status com CHECK de terminal+finished_at, `version` para
  CAS: `packages/store/src/migrations/251_control_plane_foundation.ts:62-119`.
- `agent_run_attempts` — executor lease (owner/fencing_epoch/lease_status/
  heartbeat/expiry/released_at), trigger `initial|resume|provider_fallback|
  worker_recovery`, índice parcial que garante **no máximo um attempt ativo por
  run**: `251_control_plane_foundation.ts:121-158`.
- `AgentRunStore` já implementa acquire/renew/release com verificação de
  owner+epoch e `recoverInterruptedRuns()` (fencing de attempts órfãos no
  boot): `packages/store/src/control-plane/agent-run-store.ts`.
- Trigger de imutabilidade de `wait_mode` (D-013):
  `packages/store/src/migrations/252_control_plane_alignment.ts`.

### Contratos (`@mcp/agent-runtime-contracts`)

- `AgentRunSpec` (com `waitMode`, `budget`, `verifierPolicy`,
  `idempotencyKey`), `AgentRun`, `AgentRunAttempt`, `ExecutorLease`,
  `canTransitionAgentRun`: `packages/agent-runtime-contracts/src/runs.ts`.
- `ResolvedAgentRun` + `isResolvedAgentRun` — distinção run pré/pós-resolução
  (a Fase 3 é quem passa a PREENCHER a resolução): `runs.ts` (Fase 1-alignment).
- `UltraPreset`/`PresetResolution` (dimensões separadas + requested/effective +
  reasons): `packages/agent-runtime-contracts/src/ultra.ts` — ainda SEM
  consumidor; a Fase 3E é o primeiro.
- `VerifierPolicy` (`off|selective|required`): `runs.ts`.
- `HandoffArtifact`/`Claim`/`VerifierResult`:
  `packages/agent-runtime-contracts/src/artifacts.ts` — sem consumidor; 3D usa.

### Runtime existente (adapters, não substituição)

- Shadow do coder local cria run+attempt por command, renova lease (10 min/1
  min), terminaliza com fencing em crash/evict:
  `apps/http-api/control-plane-shadow.ts`, `apps/http-api/sse/CoderWorkerPool.ts`.
- Resume de subagentes é explicitamente **process-only** (WeakRef, morre com o
  processo): `packages/code-agent/src/tools/subagent-resume-registry.ts:1-15` —
  este é o gap central que 3A fecha.
- Workflow DAG atual: waves, skip determinístico, digests bounded —
  `packages/code-agent/src/tools/workflow/workflow-run.ts:26-125` — mas estado
  vive em memória do processo; 3C o persiste.
- Background job manager e parent parking funcionais:
  `packages/code-agent/src/core/runner/orchestrator.ts:210-230`.
- Execution mode/keyword Ultra separados de provider controls no host:
  `packages/code-agent/src/sessions/execution-mode.ts:15-45`.

### Decisões vinculantes

- **D-006** — BT runner é preservado; contratos envolvem, não substituem.
- **D-008** — foreground/background compartilham `AgentRun`; wait é do caller.
- **D-013** — `wait_mode` é snapshot imutável da spec (trigger no banco).
- **D-014** — `UNIQUE(command_id)` vale na Fase 1; **a Fase 3 exige o
  relaxamento** via table rebuild (decisão pendente §4).
- **D-016** — composição via porta única; o mesmo padrão deve ser usado para o
  runner adapter da 3A (nada de gates/paths paralelos).

## 3. Escopo 3A–3E (reutiliza vs. cria)

### 3A — AgentRun store (`15:309-317`)

| Reutiliza | Cria |
|---|---|
| Tabelas 251 + `AgentRunStore` (lease/CAS/fencing/recovery) | Persistir `PresetResolution` versionada e capability/environment refs no aceite (preencher `ResolvedAgentRun`) |
| `ResolvedAgentRun`/`isResolvedAgentRun` | Exigir fencing epoch atual ANTES de provider call, capability side effect e terminal commit (hoje só o host-side lifecycle é fenceado) |
| Shadow adapter do coder | Runner adapter para spawn_agent/subagentes: cada subagente vira um `AgentRun` filho durável; stop/resume/collect idempotentes substituindo o registry WeakRef |

### 3B — Foreground/background unification (`15:319-324`)

| Reutiliza | Cria |
|---|---|
| D-008/D-013 + trigger | Background job manager vira executor adapter/cache sobre o MESMO `AgentRun` (um run detached é o mesmo row, não outra entidade) |
| Parent parking do orchestrator | Equivalência de lifecycle/events/result store entre wait e detach (gate 4) |

### 3C — Durable workflow (`15:326-332`)

| Reutiliza | Cria |
|---|---|
| Workflow DAG/waves/digests atuais | Tabelas de workflow definition/steps/attempts/result refs (migration aditiva); readiness/skip derivados do store |
| Journal (classes A–C, eventos `workflow.run.*` já definidos na Fase 1-alignment) | Steps completed nunca relançados por restart; workflow events journaled com version |

### 3D — Verifier policy (`15:334-340`)

| Reutiliza | Cria |
|---|---|
| `VerifierPolicy`/`VerifierResult`/`Claim` (contratos) | Seleção por risk/claim type dentro do lifecycle comum, ANTES do terminal persistido |
| Capability catalog (Fase 2) para set read-only independente | Verifier read-only (sem writes — gate 8), resultado confirmed/rejected/uncertain, sem inherited conclusions |

### 3E — UltraPreset v2 (`15:342-349`)

| Reutiliza | Cria |
|---|---|
| `UltraPreset`/`PresetResolution` (contratos sem consumidor) | Resolver requested→effective por dimensão com downgrade reasons persistidos no run |
| `execution-mode.ts` (sticky/keyword) | Sticky Ultra e keyword `ultracode` viram compatibility adapters; default behavior inalterado no início |

## 4. Decisões pendentes (bloqueiam o início de cada frente)

1. **Relaxar `UNIQUE(command_id)` (bloqueia 3A).** D-014 prevê table rebuild em
   migration aditiva própria. Decidir o modelo: (a) `UNIQUE(command_id,
   agent_run_id)` com root run distinguível por `parent_agent_run_id IS NULL`;
   ou (b) manter unicidade só para o root e ligar filhos via parent refs. A
   opção (b) preserva a idempotência de spawn do root (motivo original do
   constraint) e é a recomendação inicial.
2. **Ownership de attempts em subagentes (bloqueia 3A).** O attempt do filho
   pertence ao worker do pai (mesmo processo/isolate) ou ganha executor own?
   Afeta lease owner id, heartbeat e o fencing em crash do pai. Proposta
   inicial: owner = worker do pai com epoch próprio por filho — crash do pai
   fenceia todos os filhos de uma vez (consistente com o crash path atual do
   pool).
3. **Dual-write/backprojection do rollback (`15:393-395`).** Enquanto houver
   escape hatch, writers mantêm dual-write ou backprojection para os stores
   legados (ex.: `coder_subagent_runs`). Decidir por frente qual store legado
   permanece autoridade de leitura durante o shadow (mesma disciplina
   mirror→shadow→cohort da Fase 1).
4. **Checkpoint/transcript refs.** Attempt novo referencia checkpoint anterior
   (`14:363`) — decidir o formato do `checkpointRef` (chapters/checkpoints
   atuais do session store vs. content-addressed) antes de 3A expor resume.

## 5. Flags, métricas, gates e rollback (fiéis ao roadmap)

### Flags (`15:359-366`)

`CODER_AGENT_RUN_STORE_SHADOW`; `CODER_AGENT_RUN_STORE_READ`;
`CODER_DURABLE_WORKFLOWS`; `CODER_AGENT_FOREGROUND_BACKGROUND_V1`;
`CODER_VERIFIER_POLICY_V1`; `CODER_ULTRA_PRESET_V2`. Todas default-off;
mesma disciplina shadow→read→default das fases anteriores.

### Métricas (`15:368-378`)

resume success após restart; duplicate side-effect rate; AgentRun
terminalization completeness; orphan attempt count; workflow step rerun count;
useful-result rate por subagente; verifier precision/recall/uncertain rate;
Ultra task success/latency/tokens/cost por dimensão; downgrade frequency/reason.

### Gate go/no-go (`15:380-391`, resumo)

1. Crash/restart retoma com UMA lease vigente; owner stale falha antes de
   provider/tool/terminal side effect.
2. Completed result retorna sem reexecutar; ACK perdido → probe/reconciliation
   ou `outcome_unknown`, nunca retry por suposição.
3. Workflow restart não repete step completed.
4. Foreground/background fixture gera lifecycle/verifier equivalentes.
5. Company subordinate continua funcional sob os IDs/adapters novos.
6. Dimensão não suportada do preset gera downgrade/deny explícito auditável.
7. Fan-out só para steps independentes validados.
8. Verifier não recebe writes.
9. Benefit/cost de verifier e Ultra passa o benchmark (doc 16 — D-012: sem
   claim de eficácia sem benchmark).
10. Matriz de rollback cobre `queued/running/waiting/completed` com
    dual-write/backprojection.

### Não objetivos (`15:351-357`)

Fan-out geral por default; verificação universal por segundo modelo; remote
execution; shell isolation (Fase 5); reescrever Company Mode (apenas
compartilhar contracts).

### Rollback (`15:393-395`)

Dual-write/backprojection enquanto houver escape hatch; rollback planejado
bloqueia novos launches, fenceia/draina runs ativos, projeta completed outputs
antes do cutover; `spawn_agent`/workflow registry/Company/keyword continuam por
adapters; AgentRun rows permanecem como audit shadow após drain.

## 6. Riscos endereçados (doc 17)

| ID | Risco | Como a Fase 3 endereça |
|---|---|---|
| R-013 | AgentRun/workflow resume duplica efeito/step (Alta sem store/Alto/P0) | 3A store durável + idempotent resume; 3C completed steps nunca relançados (gates 2-3) |
| R-014 | Duas attempts ativas após resume race (Média/Alto/P0) | Índice parcial one-active já existe (251); 3A adiciona CAS+epoch em provider call/side effect/terminal (gate 1) |
| R-016 | Fan-out amplia custo sem qualidade (Média/Médio/P1, needs benchmark) | 3E separa parallelism como dimensão explícita; gate 7 + benchmark doc 16 antes de default |
| R-017 | Verifier aumenta falso positivo (Média/Alto/P1, needs benchmark) | 3D seletivo por risk/claim, read-only, uncertain como resultado válido; gate 9 |
| R-018 | Ultra mistura effort/orchestration e oculta downgrade (Alta/Médio/P1) | 3E requested/effective por dimensão + downgrade reasons persistidos (gate 6) |

## 7. Ordem sugerida de ondas

1. **Onda 0 — decisões**: resolver §4.1 (cardinalidade) e §4.2 (ownership) via
   entradas D-018+; migration de relaxamento do `UNIQUE(command_id)`.
2. **Onda 1 — 3A shadow**: runner adapter para spawn_agent/subagentes criando
   `AgentRun` filhos duráveis em shadow (`CODER_AGENT_RUN_STORE_SHADOW`),
   dual-write com `coder_subagent_runs`; fencing em provider call.
3. **Onda 2 — 3B**: unificação foreground/background sobre o run único;
   fixture de equivalência (gate 4).
4. **Onda 3 — 3C**: tabelas de workflow + readiness do store + replay de
   restart sem rerun (gate 3).
5. **Onda 4 — 3D + 3E**: verifier seletivo e UltraPreset v2 (dependem de 3A
   para lifecycle e resolução persistida); benchmark do doc 16 antes de
   qualquer default-on (gate 9).
6. **Onda 5 — leitura**: `CODER_AGENT_RUN_STORE_READ` em cohort; comparator
   legado-vs-store; gates completos e decisão de cutover.

Cada onda segue o padrão consolidado: spec aprovado → migration aditiva →
shadow default-off → testes (`:memory:` + workaround ABI) → métricas no admin →
gates antes de avançar.
