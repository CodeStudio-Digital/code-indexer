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
