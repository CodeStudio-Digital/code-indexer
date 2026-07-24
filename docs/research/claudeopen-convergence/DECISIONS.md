# Registro de decisões

Este arquivo registra decisões de produto e arquitetura que governam o atlas e os planos futuros. Alterá-las exige nova decisão explícita, não apenas uma edição editorial.

## D-001 — Entrega inicial: atlas + roadmap

- **Status:** aceito pelo usuário.
- **Escolha:** produzir documentação comparativa, traces, matriz, contratos, fases, benchmarks e riscos; não implementar runtime nesta rodada.
- **Alternativas consideradas:** atlas + primeira fundação; programa completo.
- **Motivo:** o corpus ClaudeOpen é desminificado, o CodeStudio já possui vários subsistemas maduros e a árvore está modificada. Misturar descoberta com refactor impediria medir causalidade e aumentaria o blast radius.
- **Consequência:** cada fase funcional futura deve receber plano próprio, diff limitado e gate de validação.
- **Reabrir quando:** o atlas estiver validado e houver uma primeira fatia vertical escolhida.

## D-002 — Convergência híbrida por contratos

- **Status:** aceito pelo usuário.
- **Escolha:** preservar BT runner, Company Mode, indexer/RAG, skills/plugins, memória estruturada, workflow DAG e `code_exec`; adaptar contratos eficazes do ClaudeOpen.
- **Alternativas consideradas:** control plane como programa estrutural exclusivo; paridade Claude primeiro.
- **Motivo:** o CodeStudio não é um clone incompleto. A reescrita descartaria capacidades próprias e transformaria símbolos minificados em dependência arquitetural.
- **Consequência:** toda recomendação deve usar exatamente um marcador primário canônico — `preserve CodeStudio`, `adapt ClaudeOpen`, `merge`, `reject`, `benchmark first` ou `unknown`. Ação de implementação, ressalvas e sequência ficam em coluna/notas separadas; combinações como `adapt/merge` não são estados.
- **Reabrir quando:** benchmarks demonstrarem que um mecanismo interno é estruturalmente incompatível com os contratos-alvo.

## D-003 — Journal canônico + projeções

- **Status:** aceito pelo usuário.
- **Escolha:** criar futuramente um journal lossless para lifecycle, idempotência e replay; manter o `runtime-event-log` atual como projeção diagnóstica redigida e amostrada.
- **Alternativas consideradas:** promover o log atual; manter stores como autoridade e eventos apenas transitórios.
- **Motivo:** o log atual pula deltas reconstruíveis, amostra progresso e usa retenção/rotação best-effort: `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log.ts:23-50`, `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log.ts:121-186`, `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log-storage.ts:36-95`.
- **Consequência:** SSE, diagnóstico e stores serão projeções com finalidades próprias; não haverá renomeação silenciosa do log existente.
- **Reabrir quando:** uma prova mostrar que o formato atual pode ser tornado lossless e versionado sem quebrar sua função diagnóstica nem criar migration ambígua.

## D-004 — Ultra como preset ortogonal

- **Status:** aceito pelo usuário.
- **Escolha:** separar reasoning effort, orchestration policy, parallelism, verifier policy, durability, background policy e isolation; “Ultra” é um preset desses contratos.
- **Alternativas consideradas:** modo monolítico; remover Ultra e expor apenas workflows.
- **Motivo:** no ClaudeOpen, `ultracode` grava `xhigh` e uma flag de workflow separadamente: `claudeopen/claude-code-src/agent/workflow.js:9027-9054`. No CodeStudio, Ultra é um perfil host distinto do effort do provider: `codestudio_mcp-codebase/packages/code-agent/src/sessions/execution-mode.ts:15-45`.
- **Consequência:** a UI futura deve explicar cada dimensão, capability efetiva e downgrade; keywords legadas são migração, não contrato.
- **Reabrir quando:** testes de UX demonstrarem que a decomposição não pode ser apresentada de forma compreensível.

## D-005 — Tiers são visibilidade; Policy Engine é segurança

- **Status:** aceito pelo usuário.
- **Escolha:** tiers controlam descoberta e orçamento de contexto. Toda autorização direta ou aninhada pertence a um Policy Engine único.
- **Alternativas consideradas:** tiers como permissões; remover tiers.
- **Motivo:** `code_exec` já pode acessar tools fora do tier visível, embora policy, task scope e permission gate continuem valendo: `codestudio_mcp-codebase/packages/code-agent/src/tools/code-exec.ts:90-106`, `codestudio_mcp-codebase/packages/code-agent/src/tools/code-exec.ts:600-719`.
- **Consequência:** “tool invisível” nunca será descrito como “tool proibida”. O dashboard deve distinguir capability descoberta, visível e autorizada.
- **Reabrir quando:** não previsto; misturar context budget com segurança recriaria a ambiguidade atual.

## D-006 — BT runner é preservado

- **Status:** decisão técnica baseada na investigação.
- **Escolha:** o Session Control Plane envolve o BT runner em vez de substituí-lo na primeira convergência.
- **Motivo:** a máquina atual possui estados declarativos, recovery, dwell telemetry, espera de background e shutdown reconciliation: `codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:78-282`.
- **Consequência:** os primeiros contratos padronizam commands, IDs, policy, journal e ambiente ao redor do runner.
- **Reabrir quando:** invariantes de replay/durability provarem que o engine atual não pode atendê-los por adapters.

## D-007 — Um Policy Engine, não gates paralelos

- **Status:** decisão técnica baseada na investigação.
- **Escolha:** evoluir ou adaptar `PermissionGate`, `core/policy.ts` e enforcers aplicáveis para um chokepoint único.
- **Motivo:** já existem decisões de Plan/Spec/task/sandbox em `codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:205-248`, aprovação interativa em `codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:163-273` e um enforcer de qualidade separado. Um novo gate aumentaria drift.
- **Consequência:** o rollout futuro começa em shadow mode e compara decisões antes de substituir enforcement.

## D-008 — Foreground e background compartilham `AgentRun`

- **Status:** direção de arquitetura.
- **Escolha:** representar foreground e background como o mesmo `AgentRun`; wait/detach é comportamento do chamador.
- **Motivo:** ClaudeOpen usa o mesmo executor e só alterna entre aguardar resultado ou retornar ID/output: `claudeopen/claude-code-src/agent/loop.js:840-910`.
- **Consequência:** estado, resume, abort, transcript e policy não devem divergir entre dois executores.
- **Validação futura:** equivalência de eventos e resultados com execução foreground e background do mesmo fixture.

## D-009 — Memória em camadas, sem substituir indexação

- **Status:** direção de arquitetura.
- **Escolha:** adaptar regras anti-entropia do ClaudeOpen, preservando FTS/vector, staleness e scopes do CodeStudio.
- **Motivo:** ClaudeOpen recomenda não armazenar fatos deriváveis do repositório e atualizar memórias existentes: `claudeopen/claude-code-src/agent/memory.js:413-457`. O CodeStudio já possui store tipado, recall híbrido e staleness por hash: `codestudio_mcp-codebase/docs/memory-system.md:17-37`.
- **Consequência:** memória durável não vira cópia do code index; cada layer mantém finalidade própria.

## D-010 — Ausência não prova inferioridade

- **Status:** regra metodológica.
- **Escolha:** usar `ABSENT_FROM_SNAPSHOT` para backend remoto, feature flags efetivas e lógica do modelo não observáveis.
- **Motivo:** o snapshot só classifica `cowork/dispatch` como orquestração remota, sem incluir o serviço receptor: `claudeopen/asar-src/README.md:16-18`.
- **Consequência:** a matriz usa `unknown` em vez de claims negativas não verificáveis.

## D-011 — Documentação canônica isolada

- **Status:** decisão de execução.
- **Escolha:** todos os novos arquivos ficam em `docs/research/claudeopen-convergence/`.
- **Motivo:** documentos existentes possuem baselines diferentes; rascunhos concorrentes foram detectados em `docs/agent-research/claudeopen/` durante a revalidação.
- **Consequência:** esses arquivos não são modificados nesta rodada. O `README.md` desta pasta é o índice canônico do baseline 2.1.215/3.15.1.

## D-012 — Sem claims de eficácia sem benchmark

- **Status:** regra de aceite.
- **Escolha:** arquitetura pode identificar mecanismo e hipótese; só a suíte definida em `16-evaluation-benchmark-plan.md` pode sustentar melhora causal.
- **Motivo:** o snapshot mostra contratos e telemetria, não resultados comparativos controlados.
- **Consequência:** “mais subagentes”, “xhigh” e “streaming mais granular” permanecem `HYPOTHESIS` até medição.

## D-013 — `wait_mode` como snapshot imutável da spec

- **Status:** decisão de execução.
- **Escolha:** `agent_runs.wait_mode` é um snapshot imutável de `AgentRunSpec.waitMode`, enforced pelo trigger SQLite `trg_agent_runs_wait_mode_immutable` (migration 252). Foreground/background permanece comportamento de espera do caller (D-008); mudar o wait exige um novo command/AgentRun.
- **Alternativas consideradas:** remover a coluna e derivar o wait do command; manter a coluna como estado mutável do run.
- **Motivo:** D-008 define wait/detach como comportamento do caller, não do run (`DECISIONS.md:65-71`). Sem enforcement no banco, o snapshot persistido poderia divergir silenciosamente da spec original: `packages/store/src/migrations/252_control_plane_alignment.ts`.
- **Consequência:** qualquer `UPDATE` em `wait_mode` falha fechado no banco; projeções leem um snapshot consistente com a spec; o caller continua dono da política de espera.
- **Reabrir quando:** a Fase 3 (workflow/subagents) exigir alternância de wait dentro do mesmo `AgentRun`.

## D-014 — Cardinalidade command→run na Fase 1

- **Status:** decisão de execução.
- **Escolha:** `UNIQUE(command_id)` em `agent_runs` (migration 251): na Fase 1, um command produz no máximo um `AgentRun`. A restrição será relaxada na Fase 3 (workflow/subagents geram múltiplos runs por command) via table rebuild em migration aditiva própria.
- **Alternativas consideradas:** permitir múltiplos runs por command desde já (schema sem a constraint); modelar uma tabela separada para runs de workflow.
- **Motivo:** o shadow local do coder cria exatamente um run por command (`apps/http-api/control-plane-shadow.ts`). A constraint converte violação de idempotência de spawn em erro de banco visível, em vez de dupla execução silenciosa: `packages/store/src/migrations/251_control_plane_foundation.ts:108`.
- **Consequência:** retry/reattach não cria run duplicado para o mesmo command; workflow e subagents exigem a migration de relaxamento antes de produzir múltiplos runs por command.
- **Reabrir quando:** a Fase 3 introduzir runs múltiplos por command (workflow steps, subagentes).

## D-015 — Comparação shadow↔legacy é allow-vs-block

- **Status:** decisão de execução.
- **Escolha:** a comparação do Policy Engine shadow contra o gate legado mede apenas a dimensão allow-vs-block. `PermissionGate.check` retorna `{allowed: true|false}` e colapsa deny e ask em um único bloqueio (`packages/code-agent/src/core/permission-gate.ts:144-146`); a distinção deny/ask do shadow é validada internamente por testes de precedência, não contra o legacy.
- **Alternativas consideradas:** estender o gate legado para retornar deny/ask distintos (mudaria contrato estável antes do shadow gate); comparar só quando o shadow decide allow (perderia as divergências críticas).
- **Motivo:** medir uma dimensão que o legacy não expressa produziria falsas divergências estruturais e contaminaria o agreementRate do burn-in: `packages/store/src/control-plane/policy-decision-store.ts` (`shadowToLegacyDimension`, `classifyDivergence`).
- **Consequência:** `policy_decision_comparisons.legacy_effect` só admite `allow|block`; divergência crítica é `shadow_denies_legacy_allow` ou `shadow_allows_legacy_block`; `shadow_asks_legacy_allow` é divergência não-crítica esperada.
- **Reabrir quando:** o enforcement substituir o gate legado — a partir daí a decisão nativa carrega deny/ask e a comparação deixa de existir.

## D-016 — Porta `policyShadow` como ponto único de composição

- **Status:** decisão de execução.
- **Escolha:** o dispatch (`executing-dispatch.ts`) conhece apenas uma porta opcional `policyShadow`; o único lugar que interpreta as flags `CODER_CAPABILITY_CATALOG_SHADOW`/`CODER_POLICY_ENGINE_SHADOW`/`CODER_HOOK_BUS_V1`/`CODER_RESOURCE_GRANTS`/`CODER_POLICY_ENGINE_ENFORCE` e liga catalog/policy/binding/hooks/stores é `createPolicyShadowPort` (`packages/code-agent/src/core/policy-shadow-adapter.ts`), composto em `runCoder`. Porta ausente = path byte-idêntico ao legado.
- **Alternativas consideradas:** ler flags dentro do dispatch (acoplaria o hot path aos concretes e impediria teste isolado); compor no http-api main process (a decisão ocorre no worker, onde vivem DB handle e registry).
- **Motivo:** D-007 exige um chokepoint único sem gates paralelos; a porta preserva o `PermissionGate` como decisão efetiva enquanto o shadow apenas observa e persiste.
- **Consequência:** `CODER_POLICY_ENGINE_ENFORCE` permanece dormant — implementado e testado isolado, mas habilitá-lo em produção é um gate humano separado, após burn-in com agreementRate e divergências críticas explicadas (gates 1-11 da Fase 2). Flags são re-checadas por invocação (kill switch mid-run).
- **Reabrir quando:** o burn-in sustentar enforcement e o gate legado for adaptado para consumir a `PolicyDecision` nativamente.

## D-017 — Renumeração de migrations por colisão

- **Status:** decisão de execução.
- **Escolha:** as migrations do Policy Engine planejadas como 253/254 foram renumeradas para **255** (`255_policy_engine.ts`) e **256** (`256_policy_comparison_latency.ts`) porque 253 (`253_provider_attempt_telemetry`) e 254 (`254_enable_codex_spark`) já existiam no repositório, criadas por trilhas paralelas.
- **Alternativas consideradas:** reordenar as migrations existentes (quebraria bancos já migrados); usar sufixos (253b) fora do padrão numérico do runner.
- **Motivo:** o runner de migrations aplica por versão inteira crescente (`packages/store/src/migrations/index.ts`); colisão de versão é erro silencioso de ordenação.
- **Consequência:** documentos e specs que citam "migration 253 do Policy Engine" devem ler 255; a numeração de migrations é alocada no momento do merge, não no momento do spec.
- **Reabrir quando:** não previsto; a regra "número = ordem de chegada ao index" evita a recorrência.

## D-018 — Cardinalidade command→AgentRun na Fase 3

- **Status:** decisão de execução.
- **Escolha:** um command continua produzindo no máximo um **root** `AgentRun`, enforced pelo índice único parcial `idx_agent_runs_root_command ON agent_runs(command_id) WHERE parent_agent_run_id IS NULL` (migration 257). Subagentes e workflow steps são `AgentRun` filhos (`parent_agent_run_id IS NOT NULL`) e podem compartilhar o `command_id` do turno que os originou; identidade e idempotência do filho ficam em `agent_run_id` + parent/owner refs, não em um novo command artificial.
- **Alternativas consideradas:** manter `UNIQUE(command_id)` e criar um command sintético por filho; remover toda unicidade por command; criar tabela paralela exclusiva para runs de workflow/subagente.
- **Motivo:** D-014 preservou `UNIQUE(command_id)` na Fase 1 para impedir spawn duplicado do root, mas já previu relaxamento na Fase 3. Commands sintéticos distorceriam o contrato usuário→turno e duplicariam lifecycle; remover toda unicidade perderia a proteção original contra root duplicado. O índice parcial preserva ambos os invariantes: um root e N filhos causados pelo mesmo command.
- **Consequência:** `AgentRunStore.create()` deve persistir `owner_agent_run_id`, `parent_agent_run_id` e `spawn_depth`; readers distinguem root/filho pela hierarquia; retry do root segue falhando fechado, enquanto fan-out validado pode criar múltiplos filhos sem violar cardinalidade. Rollback para readers legados mantém `coder_subagent_runs` por dual-write até drain.
- **Reabrir quando:** uma futura semântica permitir múltiplos roots legítimos para o mesmo command (por exemplo, branch/fork explícito modelado sem novo command), ou o command deixar de ser a unidade causal do turno.

## D-019 — Ownership e fencing de attempts de subagentes

- **Status:** decisão de execução.
- **Escolha:** durante a Fase 3A local, cada `AgentRun` filho recebe uma attempt com `executor_owner_id` derivado do **worker do pai**, mas com `fencing_epoch` próprio e monotônico por filho. O crash/eviction do worker do pai fenceia todas as attempts-filho ativas desse worker; cada filho continua sendo validado individualmente por `(agent_run_id, attempt_id, executor_owner_id, fencing_epoch)` antes de qualquer transição durável.
- **Alternativas consideradas:** um executor owner independente por subagente no mesmo worker; compartilhar a attempt/epoch do pai entre todos os filhos; não persistir attempts dos filhos enquanto o resume continuar process-only.
- **Motivo:** hoje o processo/worker do pai executa e supervisiona os subagentes; inventar ownership remoto não reflete a realidade operacional. Compartilhar uma única attempt/epoch destruiria isolamento de CAS e permitiria que um retry de um filho interferisse nos demais. Owner comum + epoch próprio representa a topologia real e mantém fencing granular, alinhado ao crash path do `CoderWorkerPool`.
- **Consequência:** heartbeat/eviction pode selecionar attempts por `executor_owner_id` e fencear o conjunto no crash do pai, mas resume/retry de um filho cria uma nova attempt e um novo epoch somente para aquele `AgentRun`. A Onda 3A shadow apenas persiste/observa esse modelo; enforcement antes de provider call/tool side effect permanece gate posterior.
- **Reabrir quando:** subagentes ganharem execução remota/isolada ou puderem migrar entre workers sem reiniciar a attempt; nesse caso o owner passa a identificar o executor real e exige protocolo explícito de transferência de lease.
