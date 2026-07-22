# 11 — CodeStudio: memória, prompts e hooks

## Pergunta respondida

Como o CodeStudio compõe contexto, preserva cache, recupera conhecimento, compacta histórico e executa extensões de lifecycle; quais mecanismos já superam o snapshot ClaudeOpen; e onde ainda há fragmentação ou risco de entropia?

## Resumo executivo

Memória e prompts são áreas em que o CodeStudio já possui vantagens claras:

- três layers de memória com finalidades distintas;
- store durável tipado, supersession e staleness por hash;
- recall híbrido FTS + vector com rescore;
- recuperação proativa por turno e em global workspaces;
- sessão/goal/todos/notes/recall injetados fora do system prompt;
- fronteira estática/dinâmica documentada e estável para prompt cache;
- compactação com checkpoint durável, retries e harvest sem segunda chamada de resumo;
- hooks runtime com timeout e containment;
- project hooks para prompt e tool filtering.

As lacunas são de governança e integração:

1. as regras anti-entropia da memória não aparecem como um contrato único de escrita em todas as rotas;
2. runtime hooks e project hooks possuem tipos, ordering e modelos de confiança diferentes;
3. `node:vm` limita globals, mas não deve ser chamado de fronteira de segurança forte;
4. o lifecycle de hooks é estreito comparado aos eventos necessários para policy, agents, compaction e workspace;
5. prompt, capability set e hooks precisam de provenance/versioning para auditoria e benchmark causal.

A convergência preserva store, ranking, staleness, cache boundary e checkpoints; adapta do ClaudeOpen update-before-create, anti-derivable-facts, stages de hooks e handoff explícito.

## Baseline e confiança

- CodeStudio 3.15.1: `codestudio_mcp-codebase/package.json:1-18`.
- `docs/PROMPTS.md` e `docs/memory-system.md` são as referências internas atuais.
- Confiança alta para os contratos citados; eficácia de recall, distillation e prompt variants continua hipótese até benchmark controlado.

## 1. Arquitetura de prompt

### Duas famílias

**VERIFIED.** A documentação distingue:

- prompt composto da sessão principal;
- prompts funcionais/standalone, alguns com output JSON/tagged parseado por código.

Fonte: `codestudio_mcp-codebase/docs/PROMPTS.md:20-25`.

Essa distinção é importante: mudar wording de um prompt funcional pode quebrar parser, enquanto mudar o composto pode afetar tool choice, cache e comportamento global.

### Contratos de manutenção

**VERIFIED.** Duas regras são declaradas como críticas:

1. não renomear/remover campos lidos por parsers;
2. não mover `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` nem inserir conteúdo volátil acima dele.

Fonte: `codestudio_mcp-codebase/docs/PROMPTS.md:10-16`.

### Prefixo estático e sufixo dinâmico

**VERIFIED.** O prefixo é estável para a tupla de sessão e o sufixo comporta MCP tiers, project hook e repo map. Estado por turno — goal, todos, task scope, arquivos e memória — vai para a trailing user message: `codestudio_mcp-codebase/docs/PROMPTS.md:27-38`.

**VERIFIED.** O composer declara a mesma intenção e mantém preambles por família de provider para evitar cache pollution: `codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:1-38`.

### Ordering do prompt composto

**VERIFIED.** O pipeline documentado ordena:

1. provider preamble;
2. base interpolada;
3. plan/depth/agent/mode blocks;
4. interaction/loop/language/style/autonomy;
5. boundary;
6. tool cap, custom tiers, project hook, verify commands e repo map.

Fonte: `codestudio_mcp-codebase/docs/PROMPTS.md:42-74`.

**VERIFIED.** A implementação coloca permission e `AGENTS.md` acima da boundary e project hook/repo map/verify commands abaixo; o marker é sempre emitido, mesmo sem sufixo: `codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:640-696`.

Essa é uma força consolidada e corrige um gap histórico já resolvido. Não deve voltar ao roadmap como “adicionar cache boundary”.

## 2. Prompt e capability set

### Estado atual

O prompt recebe hints derivados de tiers, MCP, native tools e contextos do produto. Tools efetivamente enviadas ao provider são filtradas pelo registry/tier/profile em outro boundary.

**RISK:** se prompt hints e tool projection forem calculados por pipelines diferentes, uma mudança pode explicar capability ausente ou deixar de explicar capability presente.

### Contrato-alvo

`AgentRunSpec` deve produzir duas projeções do mesmo `ResolvedCapabilitySet`:

- provider-facing tool descriptors;
- prompt-facing capability summary.

Ambas devem registrar hash/version para permitir:

- replay;
- comparação de tool-choice;
- cache diagnosis;
- downgrade explanation;
- auditoria de role/policy.

Não se recomenda inserir todos os schemas no prompt; progressive disclosure continua necessária.

## 3. Project instructions

### `AGENTS.md`

**VERIFIED.** `agentsMdSection` apresenta instruções hierárquicas como convenções de projeto, subordinadas a conflito com pedido direto do usuário: `codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:699-712`.

### Project hook de system prompt

**VERIFIED.** `.mcp-indexer/hooks/system-prompt.js` pode acrescentar instruções; seu output fica no sufixo dinâmico: `codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:661-672`.

### Relação com ClaudeOpen

ClaudeOpen distingue Project, Local e AutoMem: `claudeopen/claude-code-src/agent/memory.js:3194`. O CodeStudio deve tornar provenance equivalente visível:

- system policy;
- managed organization policy;
- `AGENTS.md`/project instruction;
- local/user preference;
- plugin/project hook augmentation;
- retrieved memory;
- active context.

A precedência deve ser documentada e testada; provenance não precisa ser exposta como texto longo ao usuário em todo turno.

## 4. Layers de memória

### Separação canônica

**VERIFIED.** O CodeStudio possui três layers distintas:

| Layer | Store | Propósito |
|---|---|---|
| Session notes | `coder_session_memory` | scratchpad da sessão, sobrevive a compactação |
| Agent Memory | `agent_memory` | conhecimento durável cross-session |
| Snapshots | `snapshots` | contexto/review curado e indexado |

Fonte: `codestudio_mcp-codebase/docs/memory-system.md:1-15`.

Essa separação é uma superioridade sobre qualquer leitura simplificada de `MEMORY.md` como memória única.

### Modelo durável

**VERIFIED.** Uma memória possui identidade, descrição, tipo e scope. Types são fechados; scopes incluem project, user e local: `codestudio_mcp-codebase/docs/memory-system.md:17-24`.

### Supersession

**VERIFIED.** Conteúdo não é editado in-place como source of truth: a row antiga é arquivada, uma nova é criada e `superseded_by_id` preserva histórico e uma única identidade viva: `codestudio_mcp-codebase/docs/memory-system.md:19-25`.

Isso implementa, em nível de store, uma forma mais forte de update-before-create do que depender somente de prompt.

### Staleness

**VERIFIED.** `referenced_files` captura hashes e recall marca a memória stale quando os arquivos mudam: `codestudio_mcp-codebase/docs/memory-system.md:24-25`.

ClaudeOpen recomenda não salvar fatos deriváveis do repo: `claudeopen/claude-code-src/agent/memory.js:413`. As duas ideias se complementam:

- anti-derivable-facts previne entropia;
- hash staleness reduz dano quando um fato referenciado ainda muda.

## 5. Recuperação

### Recall proativo

**VERIFIED.** O runner recupera memória relevante antes de montar mensagens, no turno inicial e quando a tarefa muda materialmente; o selector é conservador e limita a cinco entradas. Um pedido “ignore memory” desliga recall e índice naquele turno: `codestudio_mcp-codebase/docs/memory-system.md:27-31`.

### Ranking

**VERIFIED.** Recall combina candidatos FTS e vector por RRF, depois aplica relevance, importance, recency, usage frequency e staleness discount: `codestudio_mcp-codebase/docs/memory-system.md:35-37`.

### Global workspace

**VERIFIED.** O host recupera diretamente em projeto único; em union workspace, consulta projetos concorrentemente e intercala resultados com labels: `codestudio_mcp-codebase/packages/code-agent/src/index.ts:2518-2542`.

### Query synthesis

**VERIFIED.** Há synthesizer opcional para mensagens meta/continuação; falha é fail-open para heurística: `codestudio_mcp-codebase/packages/code-agent/src/index.ts:2543-2550`.

### Continuidade estruturada

**VERIFIED.** O runner também constrói um session state tail com goal, plan, todos, notes, files e recall, evitando depender apenas da sumarização: `codestudio_mcp-codebase/packages/code-agent/src/index.ts:2551-2555`.

## 6. Escrita, distillation e manutenção

### Escrita explícita

O agente usa `remember`, `recall_memory` e `forget_memory`; session notes usam `save_note`. O code map está em `codestudio_mcp-codebase/docs/memory-system.md:51-57`.

### Distillation e sweeper

**VERIFIED.** End-of-run/compaction distillation e idle sweeper criam fatos duráveis e deduplicam; o sweeper colapsa duplicatas e faz embedding backfill: `codestudio_mcp-codebase/docs/memory-system.md:29-33`.

### Harvest durante compactação

**VERIFIED.** O harvest reutiliza uma summary já paga, promove notes `decision`, `gotcha`, `convention` e `procedure`, usa timeout de 30 s e não lança no caller: `codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:1-13`, `codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:50-89`.

**VERIFIED.** O high-water mark avança em sucesso/timeout, mas não em falha real do LLM, permitindo retry pelo sweeper: `codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:91-135`.

### Lacuna anti-entropia

O store evita identidades vivas duplicadas e o sweeper consolida, mas o atlas não encontrou uma regra host-enforced universal que recuse memória cujo conteúdo é claramente derivável do repositório.

**HYPOTHESIS:** um evaluator conservador no write path reduz stale/low-value memories. Deve começar em telemetry/shadow; false rejection de decisões úteis seria regressão.

## 7. Compactação durável

### Boundary transacional

**VERIFIED.** Antes do checkpoint, o host flusha assistant/tool pair e alinha o summarized head com o prefixo visível do DB; chapter + boundary são anexados atomicamente: `codestudio_mcp-codebase/packages/code-agent/src/index.ts:3312-3358`.

O comentário registra um incidente anterior em que cursor numérico ficou além do array após compactação e tool messages deixaram de persistir; o pipeline atual usa turn buffer transacional: `codestudio_mcp-codebase/packages/code-agent/src/index.ts:3312-3323`.

### Retry coordenado

**VERIFIED.** `DurableCheckpointCoordinator` retenta somente falha de transporte/storage, com backoff por turnos; uma summary nova supersede checkpoint stale: `codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/checkpoint-retry.ts:30-72`.

**VERIFIED.** No-op de alignment não é repetido indefinidamente; failures possuem limite default de três attempts: `codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/checkpoint-retry.ts:75-122`.

Essa é uma força do CodeStudio que deve permanecer acima do mecanismo ClaudeOpen observado apenas como stream/event.

## 8. Sync e telemetry de memória

### Sync

**VERIFIED.** Intent de sync existe por row, local scope força sync off e push cloud depende de entitlement pago: `codestudio_mcp-codebase/docs/memory-system.md:39-41`.

### Telemetry

**VERIFIED.** Eventos de remember/recall/forget e `memory_distill_log` permitem medir atividade e qualidade operacional: `codestudio_mcp-codebase/docs/memory-system.md:43-45`.

**Gap de avaliação:** atividade não prova utilidade. O benchmark precisa medir task success, stale-memory error, precision@k, duplicate rate e token overhead.

## 9. Runtime hooks

### Contrato atual

**VERIFIED.** `RuntimeHookRegistry` oferece:

- tool call before/after;
- provider/tool/doom-loop/timeout error;
- fallback;
- completion.

Contextos carregam session/project/provider/model/turn e campos específicos: `codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:1-60`.

### Failure isolation

**VERIFIED.** Hooks assíncronos recebem timeout de 5 s; erro/timeout é logado e não derruba o runner: `codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:64-80`.

### Ordering

**VERIFIED.** Handlers de cada categoria rodam em ordem de registro, sequencialmente: `codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:82-129`.

### Uso em Company

**VERIFIED.** Company registra hooks de erro, fallback e completion para notificar master e board: `codestudio_mcp-codebase/packages/code-agent/src/core/company-hooks.ts:1-26`, `codestudio_mcp-codebase/packages/code-agent/src/core/company-hooks.ts:27-85`.

Isso prova utilidade prática e sugere preservar o registry como adapter no Lifecycle Event Bus futuro.

## 10. Project hooks

### Superfície

**VERIFIED.** Projetos podem fornecer:

- `.mcp-indexer/hooks/system-prompt.js`;
- `.mcp-indexer/hooks/tool-filter.js`.

Os hooks são funções puras, sem `require`, `fs` ou network expostos, com timeout de 200 ms: `codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:1-20`.

### Execução

**VERIFIED.** O script é compilado com `node:vm`, executado em context novo e failures retornam default: `codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:41-71`.

### Tool filter

**VERIFIED.** O resultado é normalizado para um `Set<string>` de tools permitidas: `codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:87-110`.

### Limite de segurança

`node:vm` reduz o conjunto de globals e contém loops pelo timeout. Não é, por si só, uma fronteira robusta contra código hostil. O futuro plugin/project hook decision path deve usar worker/process/sandbox conforme trust level.

## 11. Fragmentação de hooks

| Dimensão | Runtime hooks | Project hooks |
|---|---|---|
| Registro | programático | arquivos do projeto |
| Eventos | tool/error/fallback/completion | prompt/tool filter |
| Tipo | observation only | augmentation/filter |
| Timeout | 5 s | 200 ms |
| Execução | mesmo processo | `node:vm` no processo |
| Result | `void` | string/set |
| Provenance | caller code | path de projeto |
| Policy relation | indireta | pré-projeção de tool/prompt |

**Gap:** não há um lifecycle contract comum com event ID, source, ordering, timeout, trust, decision schema, idempotency e redaction.

## 12. Modelo de hooks recomendado

### Observation hooks

- recebem evento redigido/versionado;
- não alteram execução;
- falham open;
- podem alimentar telemetry, board, notification e webhook outbox;
- têm cursor/idempotency quando assíncronos.

### Decision hooks

- existem somente em stages explicitamente permitidos;
- retornam `allow | deny | ask | abstain` e, quando aplicável, `inputPatch` validado;
- nunca podem reduzir policy superior;
- timeout/falha seguem postura definida por stage/source;
- executam em boundary de isolamento compatível com trust.

### Prompt augmentation hooks

- retornam fragmento com provenance e cache class;
- não conseguem fingir system policy;
- possuem tamanho máximo;
- são versionados/hashados no run.

### Presentation hooks

- transformam projeção/UI sem mudar state of truth;
- não participam de policy.

## 13. Comparação com ClaudeOpen

| Aspecto | ClaudeOpen | CodeStudio | Decisão | Ação/nota |
|---|---|---|---|---|
| Project/local/auto memory | arquivos/labels separados | scopes/stores estruturados | preserve CodeStudio | mapear provenance sem fundir stores |
| AutoMem index | `MEMORY.md` | FTS + vector | preserve CodeStudio | manter retrieval híbrido |
| Anti-derivable facts | prompt explícito | staleness/dedupe, regra menos central | adapt ClaudeOpen | avaliar regra em shadow/warn |
| Update-before-create | prompt de manutenção | supersession transacional | preserve CodeStudio | reforçar UX/tool sobre identidade existente |
| Transcript/metadata | resume de agent | session store/checkpoints; subagent resume process-local | merge | ligar ao `AgentRun` durável |
| Compaction stream/event | presente | state node + durable chapter checkpoint | preserve CodeStudio | adicionar event envelope e journal refs |
| Continuation summary | prompt explícito | session state + chapters | merge | criar handoff artifact bounded com refs |
| Hook stages amplos | lifecycle extenso | dois registries parciais | merge | unificar por adapters/trust levels |
| Prompt cache boundary | referência observada | já implementada/documentada | preserve CodeStudio | proteger static prefix |

## 14. Problemas e classificação

1. **LEGACY_DOC:** comparações que ainda listam cache boundary como ausente estão desatualizadas.
2. **RISK:** prompt e capability set podem divergir sem hash/provenance comum.
3. **RISK:** project hook no `node:vm` não é security boundary forte.
4. **RISK:** dois sistemas de hooks podem evoluir com ordering e semantics conflitantes.
5. **HYPOTHESIS:** anti-derivable write evaluator reduz entropia.
6. **UX_GAP:** dashboard não mostra origem, freshness e layer da memória recuperada.
7. **UX_GAP:** compacting/checkpointing/handoff não aparecem como uma continuidade única.
8. **RISK:** hooks não possuem redaction/idempotency/version comuns.
9. **HYPOTHESIS:** capability-aligned prompt melhora tool choice e cache; exige A/B.
10. **RISK:** functional prompt contract pode quebrar sem schema/snapshot test correspondente.

## 15. Decisões de transferência

| Mecanismo | Decisão | Ação/nota |
|---|---|---|
| Store/ranking/staleness/sync | preserve CodeStudio | manter bounded layers |
| Prompt cache boundary | preserve CodeStudio | proteger static prefix por snapshot/hash |
| Durable compaction checkpoint | preserve CodeStudio | referenciá-lo no journal/handoff |
| Session state outside system prompt | preserve CodeStudio | manter na dynamic tail |
| Anti-derivable-facts | adapt ClaudeOpen | avaliar em shadow/warn antes de enforcement |
| Update-before-create | preserve CodeStudio | supersession já atende; reforçar UX/tool |
| `MEMORY.md` como novo source of truth | reject | preservar store híbrido |
| Continuation/handoff artifact | merge | combinar summary bounded com refs internas |
| Hook stages e event vocabulary | adapt ClaudeOpen | integrar ao hook bus ordenado |
| Runtime + project hook registries separados indefinidamente | reject | convergir por adapters/trust levels |
| `node:vm` como security sandbox | reject | tratar apenas como isolamento de linguagem/timeout |
| Copiar prompts ClaudeOpen | reject | contratos próprios e cache estável |
| Prompt variants e recall gains | benchmark first | exigir experimento causal |

## 16. Invariantes futuros

1. System prompt prefix é byte-stable para a tupla declarada.
2. Estado volátil permanece abaixo da boundary ou na user tail.
3. Functional prompt com parser possui schema/version e contract test.
4. Capability prompt summary deriva do mesmo set enviado ao provider.
5. Toda memória possui layer, scope, provenance e freshness.
6. Fatos deriváveis são rejeitados/avisados conforme policy, sem bloquear decisões úteis.
7. Supersession mantém uma identidade viva e histórico auditável.
8. Compactação preserva pares de tool e boundaries persistidos.
9. Checkpoint failure não se perde silenciosamente; retry/telemetry é observável.
10. Observation hook não bloqueia policy/runtime.
11. Decision hook não reduz deny superior e patch passa por schema.
12. Código de projeto/plugin hostil não executa no processo confiável sem isolamento apropriado.
13. Handoff referencia stores/IDs e não substitui source of truth.
14. “Ignore memory” desliga recall/injeção naquele turno sem apagar dados.

## 17. Gates futuros

- Snapshot byte-a-byte do system prompt por provider/profile/mode.
- Testes de tool array e capability summary com o mesmo hash.
- Precision@k e stale-memory error por task cohort.
- Write evaluator em shadow mode mede false accepts/rejects.
- Três compactações + restart preservam goal, todos, tool pairing e chapter boundary.
- Failure injection no checkpoint aciona retry/rebase esperado.
- Hook timeout, throw, malformed result e reentrância não travam runner.
- `inputPatch` inválido é rejeitado.
- Project/plugin hook roda em isolamento compatível com trust.
- Dashboard mostra layer/source/freshness sem expor secret/payload sensível.
- Handoff entre instâncias mantém goal fidelity e pending work.

## Questões abertas

- O evaluator anti-entropia deve bloquear, avisar ou somente reduzir importance?
- Qual schema versionará fragments de prompt e outputs funcionais?
- Como ordenar managed, user, project, plugin e session decision hooks?
- Quais hooks precisam ser síncronos no critical path?
- Qual boundary de processo/container é adequada para project hooks confiáveis versus plugins não confiáveis?
- Como medir causalmente prompt change sem confundir provider/model drift?
