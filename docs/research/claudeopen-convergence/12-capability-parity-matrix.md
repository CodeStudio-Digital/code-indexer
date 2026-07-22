# 12 — Matriz de capacidades e decisões de convergência

## Objetivo

Esta matriz converte os achados temáticos em decisões mecanismo a mecanismo. “Paridade” aqui não significa copiar nomes ou UI; significa verificar se o CodeStudio possui um contrato equivalente, se esse contrato é eficaz e qual ação preserva mais valor com menor risco.

## Legenda

### Estado comparativo

- **CS+** — CodeStudio possui mecanismo mais forte ou mais verificável.
- **CO+** — ClaudeOpen possui contrato/padrão mais completo no snapshot.
- **COMPLEMENTAR** — cada lado é mais forte em dimensões diferentes.
- **EQUIVALENTE** — contratos comparáveis, sem diferença material comprovada.
- **UNKNOWN** — snapshot ou evidência insuficiente.

### Decisão

- **preserve CodeStudio**;
- **adapt ClaudeOpen**;
- **merge**;
- **reject**;
- **benchmark first**;
- **unknown**.

### Prioridade

- **P0** — fundação necessária para claims de durabilidade, policy ou segurança.
- **P1** — grande impacto em eficácia/UX após a fundação.
- **P2** — otimização/ecossistema posterior.
- **Defer** — depende de evidência externa ou fases anteriores.

## Matriz executiva

| # | Domínio | Mecanismo | Estado | Decisão | Prioridade | Razão curta |
|---:|---|---|---|---|---|---|
| 1 | Runner | Máquina de estados explícita | CS+ | preserve CodeStudio | P0 | BT possui nodes, transitions, recovery e tests |
| 2 | Runner | Event pump público | COMPLEMENTAR | merge | P0 | manter BT; adicionar envelope/journal canônico |
| 3 | Sessão | Command idempotente durável | UNKNOWN no ClaudeOpen; Gap CS | merge | P0 | preservar o fast path e criar ledger próprio; agent resume não prova command ledger genérico |
| 4 | Sessão | Attach/resume/fork/stop uniformes | UNKNOWN como façade ClaudeOpen; Gap CS | merge | P1 | compor routes/runs atuais sob commands próprios; não atribuir façade completa ao snapshot |
| 5 | Eventos | Replay live | CS+ | preserve CodeStudio | P0 | busId/seq/byte cap/backpressure/FIFO |
| 6 | Eventos | Journal lossless | Gap CS | merge | P0 | runtime log atual é diagnóstico amostrado |
| 7 | Tools | Descriptor rico | CS+ | preserve CodeStudio | P0 | `CoderTool` já expressa risco, timeout e output |
| 8 | Tools | Runtime capability projection | COMPLEMENTAR | merge | P0 | tiers/profiles + exact tools por AgentRun |
| 9 | Tools | Progressive disclosure | CS+ | preserve CodeStudio | P0 | tiers dinâmicos, history inference, priorities |
| 10 | Policy | Effect `allow/deny/ask` uniforme | CO+ | merge | P0 | policy binária e permission gate separados |
| 11 | Policy | Grants restritos por recurso | CO+ princípio | merge | P0 | grant atual é por tool name |
| 12 | Policy | Background non-interactive | CS+ | preserve CodeStudio | P0 | ask vira deny explicitamente |
| 13 | MCP | Connection lifecycle rico | CO+ | adapt ClaudeOpen | P1 | auth/status/capabilities/cleanup first-class |
| 14 | MCP | Namespace e tier dinâmico | CS+ | preserve CodeStudio | P0 | prefixo estável e default tier por server |
| 15 | MCP | Auth taxonomy | CO+ | adapt ClaudeOpen | P1 | `needs-auth` deve ser estado explícito |
| 16 | Nested tools | Batching e policy | CS+ | preserve CodeStudio | P0 | `code_exec` aplica gates/lanes por call |
| 17 | Subagente | Rich `AgentRun` identity | CO+ | adapt ClaudeOpen | P0 | parent/owner/depth/model/capability/resume |
| 18 | Subagente | Specialized profiles | CS+ | preserve CodeStudio | P0 | explore/implement/verify/review/full |
| 19 | Subagente | Foreground/background executor único | COMPLEMENTAR | merge | P0 | implementação já converge; falta entidade durável |
| 20 | Subagente | Resume após restart | CO+ local, unknown cloud | merge | P0 | CodeStudio é explicitamente process-local |
| 21 | Workflow | DAG declarativa e digests | CS+ | preserve CodeStudio | P0 | waves e contexto de dependências bounded |
| 22 | Workflow | Persistência durável de steps | UNKNOWN no ClaudeOpen; Gap CS | merge | P0 | o snapshot persiste scripts, não prova checkpoints/resultados de steps; preservar DAG e criar store próprio |
| 23 | Workflow | Verifier independente por claim | CO+ | benchmark first | P1 | profile existe; seleção causal ainda não |
| 24 | Teams | Coordenação persistente/board | CS+ | preserve CodeStudio | P1 | não substituir por teams efêmeros |
| 25 | Isolamento | Worktree tools | CS+ base | preserve CodeStudio | P0 | falta lease/ownership automático |
| 26 | Isolamento | Shell dentro de scope | Gap CS | merge | P0 | fence atual cobre writes nativas, não shell |
| 27 | Ultra | Effort e orchestration separados | CO+ | adapt ClaudeOpen | P0 | `ultracode` grava dois controles |
| 28 | Ultra | Workflow DAG explícito | CS+ | preserve CodeStudio | P1 | engine já possui dependências/waves |
| 29 | Ultra | Requested/effective downgrade | CO+ | adapt ClaudeOpen | P1 | provider/model constraints precisam ser visíveis |
| 30 | Ultra | Fan-out automático | UNKNOWN | benchmark first | P2 | mais agentes não prova qualidade |
| 31 | Prompt | Static/dynamic cache boundary | CS+ | preserve CodeStudio | P0 | já implementada e documentada |
| 32 | Prompt | Capability-aligned prompt | COMPLEMENTAR | merge | P1 | duas projeções do mesmo resolved set |
| 33 | Hooks | Stage vocabulary amplo | CO+ | adapt ClaudeOpen | P1 | CodeStudio possui registries fragmentados |
| 34 | Hooks | Timeout/failure containment | CS+ | preserve CodeStudio | P0 | 5 s runtime, 200 ms project |
| 35 | Hooks | Isolamento de código hostil | Gap/UNKNOWN | merge | P1 | `node:vm` não é boundary de segurança |
| 36 | Memória | Store/ranking/staleness | CS+ | preserve CodeStudio | P0 | FTS/vector/supersession/hash |
| 37 | Memória | Anti-derivable-facts | CO+ | adapt ClaudeOpen | P1 | reduz entropia e duplicação do index |
| 38 | Memória | Update-before-create | CS+ | preserve CodeStudio | P0 | supersession transacional já existe |
| 39 | Memória | Handoff explícito | CO+ | merge | P1 | integrar chapters/session state com artifact |
| 40 | Compactação | Durable checkpoint | CS+ | preserve CodeStudio | P0 | flush, alignment, retry/rebase |
| 41 | Streaming | Backpressure e renderer batching | CS+ | preserve CodeStudio | P0 | crítica antiga não se aplica |
| 42 | Streaming | Connection phases no coder | Gap UX | preserve CodeStudio | P1 | client suporta, coder não projeta |
| 43 | Dashboard | Runtime boundary clarity | CO+ conceitual | merge | P1 | mostrar live/replay/persisting/terminal |
| 44 | Processos | Worker specialization | COMPLEMENTAR | merge | P1 | CodeStudio tem workers; falta supervisor uniforme |
| 45 | Ambiente | Unified execution target | Gap CS | merge | P0 | host/worktree/container/remote precisam contrato |
| 46 | Secrets/network | Host-owned broker | UNKNOWN/Gap CS | merge | P0 | requisito próprio, não claim de snapshot |
| 47 | Plugins/skills | Ecossistema extensível | CS+ | preserve CodeStudio | P1 | skills, plugins e tiers dinâmicos |
| 48 | Indexação/RAG | MCP Code Indexer e Docs RAG | CS+ | preserve CodeStudio | P0 | superioridade própria, não buscar paridade |
| 49 | Computer use | VM/Cowork | UNKNOWN | unknown | Defer | backend/garantias ausentes do snapshot |
| 50 | Eficácia | Claims causais | UNKNOWN | benchmark first | P0 | snapshot prova mecanismo, não resultado |

## Matriz detalhada

### A. Runner, sessão e lifecycle

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Loop principal | Async generator que normaliza setup, query, partials, tools e terminal | BT com nodes e transition table | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/loop.js:4804-4863`; CS `codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:97-194` |
| Estados explícitos | Eventos/terminal reasons observáveis, mas state machine pública não foi identificada | `Bootstrap`, `Planning`, `Executing`, `Compacting`, `Reviewing`, `Recovering`, `Done` | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/transitions.ts:21-58` |
| Exception de node | Erros viram eventos estruturados em vários boundaries | Throw de node vira `Aborted` e terminal `done` | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:135-168` |
| Progress público | Bash/PowerShell/tool/retry normalizados | Vocabulário rico via runner wiring | EQUIVALENTE/COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/loop.js:5195-5252`; CS `codestudio_mcp-codebase/apps/http-api/sse/runnerWiring.ts:21-178` |
| Terminal rico | duração, API time, turns, cost, usage, denials, session ID | reason, usage, transcript boundary e quality posterior | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/loop.js:5282-5320`; CS `codestudio_mcp-codebase/packages/code-agent/src/index.ts:3490-3546` |
| Command idempotency | Agent resume possui exclusão local; command ledger genérico não foi estabelecido | `client_msg_id` deduplica enquanto store/bus existem | UNKNOWN no ClaudeOpen; gap de durability no CodeStudio | merge | CO `claudeopen/claude-code-src/agent/loop.js:580-617`; CS `codestudio_mcp-codebase/apps/http-api/server/routes/recent-message-keys.ts:5-34` |
| Pending interaction | Snapshot mostra hooks/permissões de sessão | Assistant tool_use é checkpointed antes do wait | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/index.ts:3080-3144` |
| Shutdown | Cleanup no executor/MCP | tasks recovered, operations aborted, writer drained | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:232-261`; `codestudio_mcp-codebase/packages/code-agent/src/index.ts:3555-3575` |

### B. Tools e capabilities

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Descriptor | Nome, aliases, hint, schemas, result cap, dynamic description, async call | Source, schema, output policy, risk, mutation, parallel, repeat, sandbox, scope, timeout | CS+ em metadata; CO+ em aliases/search hints | merge | CO `claudeopen/claude-code-src/agent/tools.js:17285-17323`; CS `codestudio_mcp-codebase/packages/code-agent/src/core/tool.ts:59-180` |
| Registry | Tool set composto no loop | Registry único com duplicate rejection, alias normalization e structured exception | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/core/registry.ts:5-95` |
| Exact set por role | MCP/skill/agent/permission filters e `useExactTools` | tiers + profile allowlists + runtime filters | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/loop.js:736-780`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/micro-agent-profiles.ts:83-118` |
| Lazy discovery | Tool Search/aliases observados | `find_tools`, `expand_toolset`, dynamic tiers, pins | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:518-675` |
| Nested batching | Não localizado como VM JS equivalente | `code_exec` com list/schema/stash/change, policy, timeout e unsafe lane | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/tools/code-exec.ts:90-108`, `codestudio_mcp-codebase/packages/code-agent/src/tools/code-exec.ts:611-830` |
| Result hygiene | Read detecta conteúdo inalterado/redundante | output policy, result store, read coverage/dedup | COMPLEMENTAR | benchmark first | CO `claudeopen/claude-code-src/agent/tools.js:4424-4429`; CS `codestudio_mcp-codebase/packages/code-agent/src/core/tool.ts:68-75` |

### C. MCP e integrações

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Connection object | client, type, capabilities, server info, instructions, config, cleanup, transport errors | manager mantém connection state e gera tools/tier map | CO+ no contract lifecycle | adapt ClaudeOpen | CO `claudeopen/claude-code-src/agent/mcp.js:7731-7767`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:220-271` |
| Auth state | 401/403 → `needs-auth`; Desktop reconnect após OAuth | Manager possui state/error; taxonomy unificada não aparece no `CoderTool` | CO+ | adapt ClaudeOpen | CO `claudeopen/claude-code-src/agent/mcp.js:8236-8254`; Desktop `claudeopen/asar-src/config/settings/index.chunk-BAm06TaJ.js:48-69` |
| Transport taxonomy | stdio/SSE/HTTP | external manager/pool e internal bridges | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/mcp.js:7740-7751` |
| Namespace | Protege prefixos internos confiáveis | `ext_<serverId>__<tool>` + duplicate rejection | COMPLEMENTAR | merge | CO `claudeopen/asar-src/telemetry/events/index.chunk-C6YaFt7_.js:31-47`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:235-257` |
| Cache stability | Não avaliado isoladamente | Tools externas ordenadas e tier filtering preserva ordem | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:268-271`; `codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:661-675` |
| MCP direct no Desktop | Runtime próprio SSE/HTTP/OAuth | Pool/manager no http-api/worker | COMPLEMENTAR | merge | `claudeopen/asar-src/README.md:20-25`; `codestudio_mcp-codebase/apps/http-api/workers/coder-worker.ts:869-875` |

### D. Policy, permission e trust

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Modes | `default`, `acceptEdits`, `auto`, `dontAsk`, `plan`, `bypassPermissions` | `ask`, `auto`, `unrestricted` + Plan/Spec/task/sandbox/admin | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/permissions.js:790-870`; CS `codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:25-29` |
| Decision type | classify/allow/deny/ask | static policy allow/deny + PermissionGate ask | CO+ na união | merge | CO `claudeopen/claude-code-src/agent/permissions.js:836-873`; CS `codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:230-248` |
| Plan/spec/task gates | Plan permission mode | host-enforced metadata/scope gates | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:426-470` |
| Background approval | Não atribuída sem trace específico | ask auto-denies em detached context | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:178-197` |
| DB write | Não avaliado | auto/unrestricted não basta; grant explícito necessário | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:199-234` |
| Grant scope | Snapshot indica modes/config; persistence completa não auditada | “always allow” é set por tool name | Gap CS verificável | merge | `codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:247-250` |
| Tier semantics | Runtime filters capability set | código declara visibility, not authority | CS+ conceitual | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:627-633` |

### E. Subagentes, workflows e teams

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Launch spec | prompt, subtype, model, background, isolation, cwd, depth | task, profile, files, background, persistent, research budgets | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/tools.js:17314-17329`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent.ts:106-175` |
| Identity | owner, parent, depth, model, definition, directory, abort | session/group/index/profile; Company tem run/role/card | CO+ para efêmero | adapt ClaudeOpen | CO `claudeopen/claude-code-src/agent/loop.js:793-809` |
| Model resolution | env → arg → frontmatter → parent, com fallback telemetry | provider/effort resolvidos por profile; requested/effective não unificados no run | CO+ | adapt ClaudeOpen | `claudeopen/claude-code-src/agent/loop.js:40-136` |
| Resume exclusion | `resuming` e running recusam concorrência | workflow run lock; subagent resume in-flight set | EQUIVALENTE process-local | merge | CO `claudeopen/claude-code-src/agent/loop.js:580-617`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-tool.ts:204-209` |
| Resume durability | transcript + metadata + memory mirror no processo | transcript reparado/capped, explicitamente process-only | CO+ no snapshot local | merge | CO `claudeopen/claude-code-src/agent/loop.js:618-669`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-resume-registry.ts:1-15` |
| Foreground/background | mesmo stream; await versus handle | same profiles/engine; background manager e parent parking | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/loop.js:840-910`; CS `codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:210-230` |
| Observer/verifier | observer com exact tools; review workflow verifica claims | verify/review profiles read-only | COMPLEMENTAR | benchmark first | CO `claudeopen/claude-code-src/agent/loop.js:724-823`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/micro-agent-profiles.ts:17-57` |
| Workflow | definição/script persistido + feature gates; step/runtime durability não estabelecida | DAG/waves/status/digests/events, process-local | CS+ na estrutura explícita; durability de steps é gap próprio | preserve CodeStudio | CO `claudeopen/claude-code-src/agent/workflow.js:426-481`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:26-125` |
| Teams/company | teammates/comms/task primitives | Company master/subordinates/board/kanban | CS+ em persistência de produto | preserve CodeStudio | CO `claudeopen/claude-code-src/agent/teams.js:3-18`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent.ts:768-806` |
| Fan-out verifier | finders por ângulo + verifier por `(file,line)` | workflow suporta DAG e verifier, policy de seleção não padronizada | CO+ padrão, CS+ engine | benchmark first | `claudeopen/claude-code-src/agent/memory.js:4314-4315` |

### F. Ultra, effort e thinking

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Semântica Ultra | `xhigh + dynamic workflow orchestration`, sessão | host execution profile + keyword por run | CO+ em decomposição visível | merge | CO `claudeopen/claude-code-src/agent/workflow.js:8823-8858`; CS `codestudio_mcp-codebase/packages/code-agent/src/sessions/execution-mode.ts:15-45` |
| Gates | workflow, org, model, launch pin, env override | session/keyword/kill switch; provider downgrade não unificado | CO+ | adapt ClaudeOpen | `claudeopen/claude-code-src/agent/workflow.js:9005-9047` |
| Persisted state | `value: xhigh` + `ultracode: true` | execution mode e effort separados no store, sentinel efetivo `ultra` | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/workflow.js:9027-9038`; CS `codestudio_mcp-codebase/packages/code-agent/src/index.ts:340-454` |
| Extended thinking | setting separado | provider capabilities separadas, mas UX não analisada integralmente | EQUIVALENTE conceitual | preserve CodeStudio | `claudeopen/asar-src/config/settings/index.chunk-BAm06TaJ.js:546-552` |
| Keyword `ultrathink` | attachment feature-gated vira reminder meta de raciocínio mais profundo no turno | equivalente não auditado | CO+ no mecanismo observado; eficácia/rollout UNKNOWN | benchmark first | `claudeopen/claude-code-src/vendor/misc.js:54737-54752`; `claudeopen/claude-code-src/agent/tools.js:48778-48785`; `claudeopen/claude-code-src/agent/workflow.js:10215-10218` |
| DAG disponível | dynamic workflows | `workflow` somente em Ultra | CS+ em estrutura, gap de durability | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-tool.ts:1-8` |
| Eficácia | Não comprovada no snapshot | Não comprovada | UNKNOWN | benchmark first | `16-evaluation-benchmark-plan.md` |

### G. Prompt, hooks, memória e compactação

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Prompt cache boundary | padrão identificado no corpus/histórico | marker e ordering implementados/documentados | CS+ no baseline | preserve CodeStudio | `codestudio_mcp-codebase/docs/PROMPTS.md:27-38`, `codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:640-696` |
| User prompt hook | pode bloquear/suprimir/adicionar contexto | project prompt hook só acrescenta; runtime hooks observam | CO+ em stages | adapt ClaudeOpen | `claudeopen/claude-code-src/agent/loop.js:4302-4344` |
| Hook lifecycle | tool/prompt/session/subagent/compaction stages | tool/error/fallback/completion + project prompt/filter | CO+ breadth; CS+ timeout containment | merge | CO `claudeopen/claude-code-src/agent/hooks.js:1-218`; CS `codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:1-129` |
| Hook isolation | Não comprovado como forte security boundary | project hook em `node:vm`, 200 ms | UNKNOWN/RISK | merge | `codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:41-71` |
| Memory layers | Project/Local/AutoMem + org endpoint + transcript/state | session notes + durable memory + snapshots + chapters/index | CS+ | preserve CodeStudio | CO `claudeopen/claude-code-src/agent/memory.js:3194`; CS `codestudio_mcp-codebase/docs/memory-system.md:1-25` |
| Recall ranking | `MEMORY.md` prompt index; backend org parcial | FTS/vector RRF + relevance/importance/recency/frequency/staleness | CS+ | preserve CodeStudio | CO `claudeopen/claude-code-src/agent/memory.js:239-357`; CS `codestudio_mcp-codebase/docs/memory-system.md:27-37` |
| Anti-entropia | não salvar fatos deriváveis; update/delete | supersession/staleness/sweeper; regra de derivabilidade não universal | COMPLEMENTAR | adapt ClaudeOpen | `claudeopen/claude-code-src/agent/memory.js:413-457`; `codestudio_mcp-codebase/docs/memory-system.md:17-37` |
| Compaction | streaming + compaction event | BT node + transational durable checkpoint + retry | CS+ | preserve CodeStudio | CO `claudeopen/claude-code-src/agent/compaction.js:95-141`; CS `codestudio_mcp-codebase/packages/code-agent/src/index.ts:3312-3358` |
| Memory harvest | maintenance prompt/org memory | reusa summary e high-water mark | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:1-13`, `codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:91-135` |
| Handoff | continuation summary prompt | active context/session state/chapters | COMPLEMENTAR | merge | CO `claudeopen/claude-code-src/agent/tools.js:262-283`; CS `codestudio_mcp-codebase/packages/code-agent/src/index.ts:2551-2555` |

### H. Streaming, dashboard e durabilidade

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Event source | Async event stream local; remote persistence não observada | bus live + transcript/store + sampled diagnostic log | UNKNOWN versus gap CS | merge | CO `claudeopen/claude-code-src/agent/loop.js:4804-4863`; CS `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log.ts:23-48` |
| Backpressure | Não auditada no consumer Desktop | sequential `drainChain` | CS+ verificável | preserve CodeStudio | `codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:52-61` |
| Replay cursor | Não auditado | `busId + seq`, Last-Event-ID, stale cursor reset | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:71-118` |
| Renderer replay | Não auditado | FIFO batched com event-loop yield | CS+ | preserve CodeStudio | `codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:295-345` |
| Terminal durability | Resultado rico; backend remoto ausente | worker publica `done` após `transcriptFlushed` | CS+ local | preserve CodeStudio | `codestudio_mcp-codebase/apps/http-api/workers/coder-worker.ts:884-907` |
| Diagnostic log | Telemetry events no bundle, backend não auditado | JSONL sampled/truncated/rotated best-effort | CS+ diagnóstico, gap journal | preserve CodeStudio | `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log.ts:121-223`; storage `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log-storage.ts:36-139` |
| Connection phase UX | Desktop status não auditado | Company mostra; coder client não conecta `onPhase` | Gap UX coder | preserve CodeStudio | `codestudio_mcp-codebase/apps/dashboard/hooks/useCompanyStream.ts:535-547`; coder `codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:330-347` |

### I. Ambientes, processos e ecossistema

| Mecanismo | ClaudeOpen | CodeStudio | Avaliação | Decisão | Evidência |
|---|---|---|---|---|---|
| Worker specialization | PTY, MCP, index, transcript search, shell path, heavy work | coder worker, worker pool `coder/lsp/index/plugin`, DB writer, providers | COMPLEMENTAR | merge | CO `claudeopen/asar-src/README.md:20-25`; CS `codestudio_mcp-codebase/apps/http-api/server/routes/coder/state.ts:39-65` |
| Worktree | agent resume valida worktree; fallback para cwd pai | explicit create/enter/exit with dirty guard | CS+ safety local; gap lease | preserve CodeStudio | CO `claudeopen/claude-code-src/agent/loop.js:688-697`; CS `codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:51-100`, `codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:128-238` |
| Files scope | exact tools por agent | native write fence; shell warning-only | Gap CS | merge | `codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1287-1345` |
| Sandbox driver | VM host loop no snapshot details | `ISandboxDriver` abstrai lifecycle/fs/exec/network/snapshot | CS+ contract | preserve CodeStudio | `codestudio_mcp-codebase/packages/services/src/sandbox/ports/sandbox-driver.ts:128-307` |
| Plugins/skills | plugins/skills no Desktop snapshot | extensive internal plugin/skill tiers | CS+ | preserve CodeStudio | `claudeopen/asar-src/README.md:18-25`; CodeStudio tier context `codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:611-658` |
| Index/RAG | file/transcript search workers | MCP Code Indexer, Docs RAG, snapshots, semantic navigation | CS+ | preserve CodeStudio | CodeStudio tool ecosystem documented by `codestudio_mcp-codebase/docs/ARCHITECTURE.md`; memory/index references `codestudio_mcp-codebase/docs/memory-system.md:51-57` |
| Cowork/computer use | presence/dispatch verified, backend guarantees absent | preview/browser/remote/sandbox capabilities, no equivalent full broker in scope | UNKNOWN | unknown | `claudeopen/asar-src/README.md:16-25` |

## O que torna ClaudeOpen eficaz — hipóteses verificáveis

A auditoria sustenta mecanismos, não uma conclusão global de superioridade. As hipóteses causais a testar são:

1. **Capability alignment** reduz tool-selection error.
2. **Exact role capabilities** reduzem ações irrelevantes e risco.
3. **Resume com transcript/metadata** reduz trabalho repetido.
4. **Foreground/background uniforme** reduz divergência de lifecycle.
5. **Fan-out independente + verifier por claim** melhora precisão de review.
6. **Ultra decomposto** permite aplicar effort/orchestration somente quando há retorno.
7. **Hooks por stage** tornam policy e observabilidade mais previsíveis.
8. **Anti-derivable memory** reduz staleness e prompt noise.
9. **Host-owned capabilities** melhoram revogação e recovery.
10. **Eventos causais ricos** melhoram UX e diagnóstico.

Cada item é `HYPOTHESIS` até os benchmarks de `16-evaluation-benchmark-plan.md`.

## Superioridades do CodeStudio que bloqueiam uma estratégia de clone

1. BT runner declarativo com recovery e guards.
2. Workflow DAG explícito com bounded dependency digests.
3. Company Mode e board persistente.
4. `code_exec` com policy, nested guards, timeouts e unsafe lanes.
5. Tiers dinâmicos e progressive disclosure orientada a cache.
6. Memória tipada com FTS/vector, supersession e staleness.
7. Durable compaction checkpoint com retry/rebase.
8. SSE live com backpressure, byte cap, idempotent POST retry e renderer FIFO.
9. Tool descriptor rico e risk classifier por input.
10. MCP Code Indexer, Docs RAG, snapshots, skills e plugins.

## Gaps P0 que a síntese considera comprovados

1. Não existe journal canônico lossless/versionado.
2. Não existe command ledger idempotente após restart.
3. `PolicyDecision` e `PermissionGate` não formam um result contract único.
4. Grants persistidos são amplos por tool name.
5. `AgentRun` efêmero/workflow resume é process-local.
6. `WorkspaceLease` não é a autoridade de cwd/branch/ownership.
7. Shell pode escapar do `files` scope de implementer.
8. Execution targets não compartilham um `ExecutionEnvironment` uniforme.
9. Ultra não expõe requested/effective dimensions e downgrade reasons.
10. Runtime/process supervision não possui contrato único de heartbeat/backoff/crash-loop.

## Itens que não devem ser chamados de gaps neste baseline

- Ausência de prompt cache boundary — já resolvida.
- SSE sem backpressure — já resolvido no pump atual.
- Replay renderizado integralmente sem yield — já resolvido por FIFO batched.
- Terminal SSE antes da persistência final — resolvido no worker path por `transcriptFlushed`.
- Falta de POST retry idempotency no processo — existe `client_msg_id` + bus replay.
- Memória durável inexistente — o CodeStudio tem store e ranking mais fortes.
- Orquestração multiagente inexistente — existem spawn, workflow e Company.
- Tier necessariamente inseguro — tier é visibility; o risco está em confundir semânticas.
- Cowork remoto comprovadamente superior — backend ausente do snapshot.
- `ultrathink` inexistente — há keyword feature-gated que injeta reminder contextual de raciocínio mais profundo; isso não equivale a extended-thinking/effort provider-level: `claudeopen/claude-code-src/vendor/misc.js:54737-54752`, `claudeopen/claude-code-src/agent/tools.js:48778-48785`, `claudeopen/claude-code-src/agent/workflow.js:10215-10218`.

## Próxima leitura

- Traces comparáveis: [13-end-to-end-traces.md](./13-end-to-end-traces.md)
- Contratos-alvo: [14-target-control-plane-contracts.md](./14-target-control-plane-contracts.md)
- Fases e gates: [15-roadmap-phases-gates.md](./15-roadmap-phases-gates.md)
- Benchmarks: [16-evaluation-benchmark-plan.md](./16-evaluation-benchmark-plan.md)
