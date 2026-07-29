# Registro de riscos e failure modes

> **Status:** normativo  
> **Regra:** risco não substitui requisito; ele define prova, mitigação e condição
> de reabertura.

## 1. Escala

| Campo | Valores |
|---|---|
| Probabilidade | baixa, média, alta |
| Impacto | baixo, médio, alto, crítico |
| Estado | aberto, mitigado, aceito temporariamente, encerrado |
| Owner | papel responsável, convertido em pessoa no checklist |

Um risco só muda para **mitigado** depois da evidência indicada. “Aceito
temporariamente” exige ADR com prazo. Risco crítico não pode ser aceito para C1
ou superior.

Estado inicial de `RUST-R001..060`: **aberto**. Mudanças de estado são
registradas no review do gate com evidência/ADR; a tabela abaixo permanece o
registro das causas, owners e provas exigidas.

## 2. Registro vinculante

| ID | Risco / failure mode | Prob. | Impacto | Owner | Mitigação e prova obrigatória | Gate |
|---|---|---:|---:|---|---|---|
| `RUST-R001` | Cold start por processo degrada TTFT | média | alto | Runtime | binário release pequeno, hidratação por refs, prewarm sem identidade e decomposição de latência | `GATE-PERF-01/02` |
| `RUST-R002` | Rajada de subagentes cria process storm | alta | crítico | Supervisor | admission hierárquico, reserva antes de spawn, fila bounded, limite de depth/agents/processes | `GATE-MEM-03`, chaos burst |
| `RUST-R003` | Job Object aninhado sob Electron/launcher não aceita limites ou filhos escapam | média | crítico | Platform | probe real na build empacotada, assign antes de activate, `KILL_ON_JOB_CLOSE`, teste de breakaway | `GATE-LIFE-01`, Windows matrix |
| `RUST-R004` | cgroup/rlimit/process group oferece contenção mais fraca que a declarada | média | alto | Platform | capability report no handshake, fail-closed para perfil que exige hard cap, matriz por SO | `GATE-PKG-01` |
| `RUST-R005` | Defaults Tokio multiplicam threads/stacks por process | alta | alto | Runtime | workers e blocking threads explícitos, caps de task, métrica por attempt | `GATE-MEM-02/03` |
| `RUST-R006` | `Arc` cycle, task esquecida ou mapa sem eviction causa leak lógico em Rust | média | alto | Runtime | ownership acíclico, cancel scope estruturado, heap/allocator metrics e soak | `GATE-MEM-04/05` |
| `RUST-R007` | Syscall/blocking task ignora cancelamento async | alta | alto | Tools | timeout externo, subprocess isolation quando necessário, grace seguida de hard kill | `GATE-LIFE-02/03` |
| `RUST-R008` | Hard memory limit falha como allocation error sem matar a árvore | média | crítico | Platform | tratar notification/failure como terminal, fechar Job/cgroup e validar reaping | memory-bomb chaos |
| `RUST-R009` | Provider/tool host-owned continua após runner morrer ou perder fence | média | crítico | Host adapter | registry bounded por attempt, fence watcher, cancel fan-out e TTL | `GATE-POL-01` |
| `RUST-R010` | Control e data channel entram em deadlock por backpressure cruzada | média | crítico | Protocol | canais físicos separados, janela/créditos independentes, nenhum lock aguardando ACK remoto | `GATE-IPC-01`, dual-channel chaos |
| `RUST-R011` | Deltas e outputs grandes se duplicam em heap, IPC, replay e transcript | alta | alto | Engine | thresholds obrigatórios, artifact refs, preview bounded, heap test com payload grande | `GATE-MEM-02`, payload matrix |
| `RUST-R012` | Spool ou disco enche e impede checkpoint/terminal | média | crítico | Durability | quota/reserva, backpressure, erro tipado, emergency budget para terminal, disk-full chaos | `GATE-REC-01` |
| `RUST-R013` | Deduplicação por hash revela existência de conteúdo entre sessões | baixa | alto | Security | artifact ID aleatório como autorização, ACL por owner, hash nunca usado como capability | security suite |
| `RUST-R014` | Divergência entre `.proto`, tipos TS e Rust | média | crítico | Protocol | IDL único, codegen hermético, breaking check, golden bytes/hash no CI | `MIG-012` |
| `RUST-R015` | `uint64`, presence ou enum desconhecido muda significado no TypeScript | alta | alto | Protocol | bigint/string, wrappers/oneof, `UNSPECIFIED` inválido e testes cross-language | `MIG-012` |
| `RUST-R016` | Catálogo diverge entre policy host e executor Rust | média | crítico | Capabilities | descriptors versionados, canonical bytes/hash, handshake e grant vinculados ao hash | catalog golden |
| `RUST-R017` | ACK perdido após mutação leva a replay e efeito duplicado | média | crítico | Capabilities | accepted/started duráveis, idempotency key, probe/reconcile, `outcome_unknown` sem retry | `GATE-POL-01` |
| `RUST-R018` | Fence muda entre policy e syscall mutante | média | crítico | Capabilities | grant curto, fence revalidado imediatamente antes do efeito, audit event | fence chaos |
| `RUST-R019` | Um bundle recebe writers TypeScript/Rust concorrentes ou bloqueia outras sessões | média | crítico | Session store | storage generation + lease epoch persistidos, fila Rust por UUID, journal idempotente; sessões distintas escrevem em paralelo | storage-transfer/event-load gate |
| `RUST-R020` | Batching atrasa terminal ou inverte eventos | média | crítico | Control plane | terminal barrier, seq/ACK e flush obrigatório por mudança de identidade/terminal | `GATE-EVT-01` |
| `RUST-R021` | Checkpoint corrompido ou de versão incompatível impede resume | média | alto | Durability | manifest versionado, hash, write/promote atômico, reader N/N-1 ou migration explícita | `GATE-REC-01` |
| `RUST-R022` | Crash após promotion e antes do commit deixa artifact inconsistente | média | alto | Durability | publish idempotente, refcount/journal reconciliável, orphan grace e recovery scan | checkpoint boundary chaos |
| `RUST-R023` | GC remove artifact ainda referenciado ou nunca remove órfão | média | alto | Durability | mark/sweep a partir de refs duráveis, grace, dry-run e invariant scan | artifact matrix |
| `RUST-R024` | Secret aparece em argv, env herdado, protobuf, log ou dump | média | crítico | Security | handles opacos, allowlist de env, redaction na origem, scanner automatizado | `GATE-SEC-01` |
| `RUST-R025` | Path traversal, symlink ou junction escapa do workspace lease | alta | crítico | Tools/Security | resolução por handle/canonical target, fence no ponto de efeito e matriz adversarial por SO | `GATE-POL-01` |
| `RUST-R026` | Shell, PTY ou `code_exec` cria neto breakaway/orphan | alta | crítico | Tools/Platform | attach antes de executar, child registry, Job/process-group kill e post-reap scan | `GATE-LIFE-01` |
| `RUST-R027` | `code_exec` ganha DB, credential ou filesystem implícito | média | crítico | Tools/Security | processo descartável, env limpo, proxy exclusivo de capabilities e sandbox profile | security suite |
| `RUST-R028` | Estado da VM de `code_exec` é necessário para resume | baixa | médio | Product/Engine | contrato proíbe persistência da VM; tarefa deve materializar artifact/checkpoint explícito | resume suite |
| `RUST-R029` | Pai incorpora transcript integral de filhos e volta a multiplicar memória | alta | alto | Engine | summaries bounded, result/transcript refs e hot-window independente | `GATE-MEM-03` |
| `RUST-R030` | Background agent evita reaping indefinidamente | média | crítico | Supervisor | background é wait mode, não isenção de deadline; park/checkpoint/novo attempt | 24 h lifecycle |
| `RUST-R031` | Budget delegado permite overcommit do run-tree | média | crítico | Supervisor | reservation ledger atômico, child admission no host e restituição após reap | burst chaos |
| `RUST-R032` | Provider Gateway perde paridade de OAuth, failover, reasoning ou vision | média | alto | Provider host | provider permanece TS V1, fixtures por adapter e comparação semântica | `GATE-EVT-01`, provider matrix |
| `RUST-R033` | Retry físico no host conflita com fallback lógico no Rust | média | alto | Provider/Engine | operation/physical-attempt IDs separados e um terminal tipado por operação lógica | provider chaos |
| `RUST-R034` | Shadow executa provider faturável ou mutação duas vezes | baixa | crítico | Rollout | modos de shadow explícitos, executors falsos para efeito e audit de seleção | `MIG-017` |
| `RUST-R035` | Rollback inicia legado antes de fence/reap e duplica trabalho | média | crítico | Rollout | seleção durable, attempt indivisível e recovery só após autoridade encerrada | `MIG-018..023` |
| `RUST-R036` | Kill switch depende do próprio daemon falho | baixa | crítico | Host | decisão de admissão no host TS, configuração local durável e caminho offline | rollback drill |
| `RUST-R037` | Packaging, assinatura ou antivírus impede spawn | média | alto | Release | build instalada testada, hash/assinatura, path sem escrita e smoke por canal | `GATE-PKG-01` |
| `RUST-R038` | Async Rust aumenta tempo de entrega e introduz deadlock sutil | alta | médio | Runtime | crates pequenos, ports síncronos onde possível, structured concurrency, loom/model tests seletivos | CI e chaos |
| `RUST-R039` | Alterações paralelas no legado criam drift durante a migração | alta | médio | Architecture | congelar oracle por fixtures e limitar mudanças TS às fronteiras autorizadas | G0 review |
| `RUST-R040` | Sidecar é vendido como correção da baseline Electron | alta | médio | Product/Observability | dashboards separam renderer, main, supervisor e árvore de attempts | `GATE-MEM-05` |
| `RUST-R041` | Prewarm retém identidade, secret ou estado de run anterior | baixa | crítico | Supervisor | prewarm só antes de `PrepareAttempt`, sem token/catálogo privado; process é single-use | prewarm contamination test |
| `RUST-R042` | Métricas com run/session como labels explodem cardinalidade | média | alto | Observability | IDs só em traces/logs; métricas usam classes e buckets bounded | telemetry load test |
| `RUST-R043` | Environment remoto cai para execução local ou repete mutação após partição | média | crítico | Capabilities/Remote | routing imutável, auth mútua, lifecycle comum, probe e `outcome_unknown` | remote partition suite |
| `RUST-R044` | Janela/compactação/tool semantics reduzem eficácia apesar de memória melhor | média | alto | Engine/Product | corpus agentic versionado, comparação pareada e gate de não inferioridade | `GATE-QUAL-01/02` |
| `RUST-R045` | Export compartilhado escondido é apagado junto com o executor | alta | alto | Architecture | symbol disposition completo, allowlist decrescente e dependency graph zero antes do delete | `CUT-022..029` |
| `RUST-R046` | Projector Rust diverge de SSE/histórico e a UI perde ou duplica blocos | média | crítico | Host/UI | journal único, golden event traces, reconnect/cursor/dedup E2E e terminal barrier | `CUT-018`, `CUT-032` |
| `RUST-R047` | Sessão histórica ou ID legado deixa de resolver após o cutover | média | crítico | Store/API | stable ID mapping, backfill validado e leitura de bancos antigos na build sem legado | `CUT-019`, `CUT-033` |
| `RUST-R048` | Company/App Studio mistura master ou especialistas de runtimes diferentes | média | crítico | Company/Rollout | geração fixada no root, herdada pela árvore e verificada em cada child admission | `CUT-011`, `CUT-040` |
| `RUST-R049` | Package é removido enquanto provider, plugin, LSP ou tool de produto ainda importa seus tipos | alta | crítico | Architecture/Release | legado como folha, CI de import e package graph resolvido sem consumidor | `CUT-023..029` |
| `RUST-R050` | Limpeza por prefixo apaga transcript, task, goal ou dado de App Studio | média | crítico | Data | `DataDispositionManifest`, classe `unknown` fail-closed e backup/restore antes de contração | `CUT-010`, `CUT-056..058` |
| `RUST-R051` | Fallback vivo é removido antes de cobrir todas as superfícies | média | crítico | Rollout | A01–A20 green, C5 por 14 dias e stop conditions zeradas | `CUT-030`, `CUT-049` |
| `RUST-R052` | Eligibility muda no meio da attempt e tenta cair para o legado | média | crítico | Router | decisão durable antes do launch, catálogo imutável e unsupported fail-closed | `CUT-005..007`, `CUT-020` |
| `RUST-R053` | Cliente antigo que usa ID numérico ou shape legado quebra | média | alto | API | facade/projector compatível, mapping de IDs e matriz de clientes N/N-1 | `CUT-004`, `CUT-019`, `CUT-041` |
| `RUST-R054` | Source foi removido, mas build instalada ainda contém ou lança worker legado | média | alto | Release | content manifest, launch scan e teste da build empacotada | `CUT-044`, `CUT-054..055` |
| `RUST-R055` | Oracle congelado ainda transpila ou carrega o package apagado | média | médio | Test/Architecture | fixtures neutras copiadas, dependency scan de testes e build sem package | `CUT-053` |
| `RUST-R056` | Migration destrutiva impede rollback para a última build estável | média | crítico | Data/Release | expand/contract, 30 dias + uma release, reader N-1 e restore/forward-fix ensaiados | `CUT-045`, `CUT-057..058` |
| `RUST-R057` | Plugin assistant mantém mini-loop TS fora do manifest e recria a arquitetura legada | média | alto | Plugins/Runtime | A20 explícita, AgentRun restrito e CI contra novos loops/runner imports | `CUT-061` |
| `RUST-R058` | Writer legado e projector Rust gravam a mesma attempt | média | crítico | Store/Host | owner por attempt, transaction ledger, divergence test e remoção da cópia no indexer | `CUT-007..009`, `CUT-062` |
| `RUST-R059` | Falta de runtime/protocol/digest impede atribuir incidente e reproduzir rollback | alta | alto | Protocol/Observability | provenance aditiva no attempt e evento antes do primeiro canário | `CUT-005`, `CUT-059` |
| `RUST-R060` | Filho com o mesmo token abre o supervisor com `PROCESS_DUP_HANDLE`, duplica o último handle do Job e neutraliza `KILL_ON_JOB_CLOSE` | média | crítico | Platform/Security | Job é apenas contenção de recursos; para código hostil usar token restrito/AppContainer ou integridade menor, endurecer DACL do supervisor e testar `DuplicateHandle` negativamente | security suite antes de C1 mutante |

## 3. Failure modes e resposta determinística

| Evento observado | Autoridade imediata | Resultado obrigatório |
|---|---|---|
| EOF antes de `AttemptPrepared` | Host/supervisor | attempt falha como protocol/startup; nenhum `started` |
| EOF depois de `ActivateAttempt` | Host/supervisor | fence, cancel de operações host-owned, reap; recovery só em novo attempt |
| Heartbeat vivo, progresso parado | Supervisor | respeitar progress deadline; checkpoint se seguro; depois cancel/hard kill |
| Hard deadline | Supervisor | nenhuma renovação; cancel grace; kill da árvore; terminal `deadline` |
| Soft memory watermark | Runner/supervisor | parar admissões, reduzir hot state, tentar checkpoint e reportar |
| Hard memory watermark/OOM | SO/supervisor | matar a árvore; usar último checkpoint confirmado |
| Control channel bloqueado | Supervisor | data channel não mantém autoridade; fence após timeout |
| Data channel bloqueado | Runner/host | backpressure no provider/tools; control continua cancelável |
| Host crash | OS resource boundary | Job/PDEATH/cgroup policy encerra árvore ou recovery scanner a fenceia |
| Runner crash antes de capability accepted | Host | operação não executada; retry depende da policy normal |
| Runner crash depois de accepted, antes de started | Host | reconciliar o executor; não inferir automaticamente |
| Perda depois de started em mutação | Host | `outcome_unknown`, probe ou intervenção; nunca replay cego |
| Checkpoint proposal sem ACK | Runner/host | checkpoint não é confirmado; recovery usa o anterior |
| Terminal proposal sem ACK | Runner | reenviar payload idêntico até deadline; payload conflitante é protocol error |
| Artifact hash inválido | Host | rejeitar promotion, preservar diagnóstico limitado, não terminalizar como sucesso |
| Disk full | Host/runner | negar novas operações grandes, usar reserva de terminal, falhar de modo tipado |
| Fence revogado | Todos os executores | fechar admissão e cancelar; nenhuma nova provider/tool dispatch |
| Child excede budget | Supervisor | matar apenas child attempt; pai recebe terminal tipado e decide continuidade |
| Supervisor crash | Host | processos perdem authority; host mata/reconcilia grupos conhecidos e reinicia supervisor |
| Runtime route muda com attempt ativa | Router | rejeitar mudança; attempt mantém geração persistida até terminal/reap |
| Import externo legado reaparece | CI/Architecture | bloquear merge e exigir destino no symbol disposition |
| Build final contém worker legado | Release | bloquear promoção mesmo que nenhum launch tenha sido observado |
| ID histórico não resolve | API/Store | manter bridge/read path, abortar contração e executar backfill/reconciliação |
| Validação de DB diverge antes de `DROP` | Data | abortar migration destrutiva; restaurar cópia de teste e corrigir por nova migration |

## 4. Hipóteses que precisam ser medidas

As afirmações abaixo não são fatos até os gates:

- processo por attempt cabe no alvo de oito subagentes;
- spawn release permanece dentro de 250 ms em todas as máquinas suportadas;
- Provider Gateway TS não desloca retenção relevante para o host;
- mmap/page cache de binários gera compartilhamento suficiente no Windows;
- transcript por refs mantém qualidade equivalente ao legado;
- limites de cgroup/macOS fornecem comportamento operacional comparável ao Job
  Object;
- Rust session store absorve journal, métricas e projections do canário sem
  aumentar TTFT nem bloquear sessões independentes.

O resultado de uma hipótese pode exigir otimização interna. Não autoriza violar
process-per-attempt, abrir SQLite no Rust, criar writer de bundle fora do
`agent-session-store` ou embutir V8 no runner sem reabrir formalmente as
decisões correspondentes.

## 5. Condições para reabrir decisões

| Decisão | Só pode ser reaberta se |
|---|---|
| Rust | toolchain/platform impede build suportada, comprovado por spike e relatório |
| Processo por attempt | `GATE-MEM-03` ou startup falha após otimizações bounded e há protótipo com isolamento equivalente por SO |
| Provider no TS V1 | gateway impede um gate medido ou torna cancel/fencing incorreto |
| Host único escritor | throughput persiste insuficiente após batching/indexing, com benchmark e desenho de consistência |
| `code_exec` externo | nenhuma sandbox de processo satisfaz compatibilidade e segurança, com threat review |
| Protobuf gerado | requisito real não pode ser representado com compatibilidade comprovada |

Reabertura exige ADR nova; nunca edição silenciosa do texto histórico.
