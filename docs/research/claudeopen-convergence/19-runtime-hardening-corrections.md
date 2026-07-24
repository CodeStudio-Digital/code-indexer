# 19 — Correções de maturidade do runtime

## Status e método

Este documento registra as correções executadas após a auditoria do runtime
local contra o snapshot recuperado em `D:\Claude-Open`. Para cada item ele
separa:

1. o comportamento comprovado no ClaudeOpen;
2. o comportamento anterior do CodeStudio;
3. o contrato que passa a ser exigido no CodeStudio;
4. a evidência de validação.

“Inspirado pelo ClaudeOpen” não significa copiar sua topologia. O transporte
desktop recuperado usa subprocesso `stream-json`, enquanto o CodeStudio usa
worker threads, `MessagePort`, bus com replay e SSE/WebSocket. Preservamos essa
arquitetura e transferimos os invariantes úteis.

## Matriz de correções

| # | Área | ClaudeOpen verificado | CodeStudio antes | Contrato corrigido |
|---:|---|---|---|---|
| 1 | EOF de stream | O fim sem mensagem de resultado gera `stream_ended_no_result`, `system_error` e outcome `failed` (`asar-src/sessions/permissions/index.chunk-BIMQN2pr.js:8354-8388`). | Um EOF HTTP limpo sem `done/error` encerrava o cliente como sucesso. | EOF de transporte nunca é outcome da aplicação: reconectar com `Last-Event-ID`; ao esgotar o orçamento, retornar erro tipado. |
| 2 | Coalescing | Deltas adjacentes de texto, JSON parcial e thinking são agrupados por 16 ms, apenas quando field/index/parent tool coincidem; qualquer fronteira força flush (`asar-src/telemetry/events/index.chunk-haYftUj-.js:12026-12096`). | Cada delta do coder cruzava provider → runner → worker → `MessagePort` → main bus → SSE → navegador. Company apenas empacotava envelopes. | Coalescer de 16 ms antes do `MessagePort`, sensível à identidade; fronteira e terminal fazem flush; Company concatena deltas compatíveis dentro do batch existente. |
| 3 | Backpressure por assinante | A evidência transferível é reduzir o firehose antes da fronteira IPC; o snapshot não prova uma fila SSE equivalente. | SSE e Company WS usavam `Promise` chains sem limite; heartbeat podia competir com dados. | Uma fila serial limitada por assinante preserva ordem e mede bytes/itens. Slow consumer é desconectado, o run continua, e o replay retoma pelo cursor. Heartbeat textual usa a mesma fila. |
| 4 | Idempotência de command | Resume recusa concorrência e retorna trabalho já concluído sem relançar (`claude-code-src/agent/loop.js:580-669`). O snapshot não prova um ledger HTTP genérico. | `RecentMessageKeys` era `WeakRef`/TTL em memória, consultado depois de validação, normalização e preflight; havia janela de append duplicado. | O ledger SQLite faz claim atômico antes do primeiro efeito caro. Payload divergente é conflito; running só reanexa se o bus existe; terminal nunca reexecuta; running sem bus é `interrupted`, não “duplicado”. |
| 5 | Journal no hot path | O coalescer mostra que telemetria/IPC não deve multiplicar custo por token. | Espelhamentos SQLite síncronos podiam ocorrer antes de publicar cada evento ao bus. | Somente claim e terminalização autoritativos permanecem síncronos. Journal/lifecycle shadow usa fila ordenada, limitada e drenável, sem bloquear publicação. |
| 6 | Identidade de AgentRun | Resume reconstrói transcript, metadata, modelo, cwd/worktree, prompt e tools (`claude-code-src/agent/loop.js:624-880`). | Child `AgentRun` era shadow parcial, sempre `foreground`, sem resolução efetiva preenchida. | O filho persiste `waitMode`, provider/model/effort efetivos, capability ref, environment ref, policy ref e hierarquia; foreground/background compartilham o mesmo lifecycle. |
| 7 | Exclusão e fencing | O registry marca `resuming` e recusa executor concorrente (`claude-code-src/agent/loop.js:580-617`). | A lease existia no store, mas o token não era exigido antes de provider/tool side effects. | Owner + epoch precisam ser válidos imediatamente antes de provider, capability/tool side effect e terminal commit. Executor stale falha fechado. |
| 8 | Resume durável privado | Transcript e metadata em disco permitem reconstrução; transcript ausente falha explicitamente (`claude-code-src/agent/loop.js:618-697`). | Registry de subagente era explicitamente process-only. | Checkpoint privado por sessão, redigido, com TTL/byte cap/hash/schema; completed retorna resultado, failed/interrupted pode retomar, e concorrência usa lease/CAS. Nada de prompt/transcript cru no control-plane journal. |
| 9 | Workflow durável | Workflows/subagentes preservam estado suficiente para resume; completed não é relançado como novo trabalho. | Registry DAG era apenas memória do processo; restart perdia estado. | Definition/steps/outcomes são checkpointados; novo executor recarrega o DAG, converte apenas `running` órfão para pending e nunca relança `completed`. |
| 10 | Hooks reais | O lifecycle enumera tool, prompt, session, stop, subagent, compact, permission, worktree e file events (`claude-code-src/agent/hooks.js:1-218`). | `HookBus` declarava estágios, mas não era composto em produção; apenas policy podia disparar um estágio quando uma dependência opcional existia. | Um bus por run é composto quando habilitado e recebe estágios reais de run/provider/capability/policy, com ordem, timeout/failure containment e default-off comprovados. |
| 11 | Policy scope | ClaudeOpen recompõe tools/context da identidade retomada e aplica modo próprio a observers/subagentes (`claude-code-src/agent/loop.js:688-823`). | Policy shadow sempre recebia `taskScope: null`, apesar de o runner conhecer scope id/files. | Policy lê o scope vivo do runner; decisão shadow compara o mesmo contexto que os gates legados realmente aplicam. |
| 12 | Tentativas físicas de provider | O snapshot expõe lifecycle e outcome, mas não prova o mesmo schema de tentativas físicas. | `onAttempt` só tinha implementação OpenAI; retries internos podiam esconder/multiplicar chamadas físicas. | Cada adapter reporta o que conhece sem inventar: uma linha por tentativa controlada, SDK retry desligado quando o runner é autoridade, e “provider-managed/unknown” quando não há prova física. |
| 13 | Commands de Company | O resume mantém identidade e recusa executor concorrente antes de relançar trabalho (`claude-code-src/agent/loop.js:580-669`). | `/start` e `/resume` dependiam de `WeakRef`/TTL; após restart ou coleta de memória, a mesma chave podia repetir o efeito externo. | Claim/fingerprint e outcome são duráveis. Um running só reanexa ao `busId` imutavelmente vinculado ao command; bus ausente ou diferente falha explicitamente e nunca autoriza reexecução implícita. |
| 14 | Ownership no renderer | ClaudeOpen possui uma identidade de subprocesso/run por sessão e reconstrói o resume a partir dela; o snapshot não possui a mesma camada React+SSE. | Um stream Company substituído ainda podia aplicar evento/cursor/finally tardio e marcar o sucessor como desconectado. | Cada abertura possui controller+geração. Callback, cursor, reconnect, erro e teardown só atuam enquanto forem os donos; replay é drenado em FIFO com yield e o cursor avança depois do handler. |
| 15 | Heartbeat e liveness | O worker recuperado usa heartbeat de 20 s e jitter (`claude-code-src/agent/tools.js:26978-27005,27421-27470,27804`), separado de output semântico. | `ping` era descartado antes de alimentar `lastEventAt`; uma conexão saudável durante espera longa parecia travada. | Heartbeat continua fora de transcript/log/cursor, mas atualiza somente liveness com throttle e ownership guard. |
| 16 | Resultado incerto pós-crash | ClaudeOpen não promete continuar uma chamada em voo: tarefas background são perdidas no restart (`claude-code-src/agent/loop.js:1116-1120`). | Todo step `running` de workflow voltava automaticamente para `pending`, mesmo se o efeito tivesse ocorrido e só o ACK/checkpoint tivesse sido perdido. | Resume reconcilia `groupId`+step contra lifecycle/AgentRun terminal. Sem prova única, persiste `outcome_unknown` e exige um segundo retry explícito; nunca relança por suposição na mesma recuperação. |
| 17 | Fence no ponto do efeito | O registry de resume impede executor concorrente antes do relançamento (`claude-code-src/agent/loop.js:580-617`); o snapshot também não consegue desfazer efeitos externos já concluídos. | A fence era checada apenas antes/depois do handler; uma lease podia mudar durante um await e a syscall/spawn ainda ocorrer. | Invocação sela input+resource binding. Ports first-party revalidam imediatamente antes de filesystem/shell/network/database; operações cancellable recebem signal. Em `ENFORCE`, capability mutante sem boundary atestado é recusada. |
| 18 | Lease raiz ociosa | Heartbeats no ClaudeOpen são temporais, não dependem de tokens/eventos do modelo. | A lease do root AgentRun só era renovada ao publicar evento; uma espera humana maior que o TTL perdia autoridade silenciosamente. | Timer por run/owner renova bem antes do TTL, é cancelado em terminal/crash/replacement e perda de autoridade aborta/fenceia o executor. |
| 19 | Replay do turno vivo | O coalescer preserva fronteiras e não descarta prefixo semântico do resultado em voo. | O cap do attach era aplicado ao replay inteiro; um turno vivo com mais de 600 eventos perdia seu começo, ainda não persistido. | O cap atua só no prefixo cross-turn reconstruível. O tail desde o último `message_complete` fica integral, limitado pelo ring global de 2.000 eventos/8 MiB. |
| 20 | Gate de orçamento sem UI | O snapshot demonstra prompts/lifecycles interativos, mas não contém o gate específico `execute_tasks` do CodeStudio. | `budget_request` não atravessava o bus e `waitForUserInput(askId)` podia bloquear para sempre quando a UI não o implementava. | O evento cruza o bus depois de flush; superfícies antigas/headless têm timeout finito, resolvem o slot keyed e caem em `cancel_pending`, sem deixar o run preso. |
| 21 | Preflight de capability aninhada | `updatedInput` de hook é validado e volta ao pipeline de permissionamento antes da execução; schema inválido ou hook negado para a tool (`claude-code-src/agent/hooks.js:1693-1727,1779-1803,1935-2019`). | `code_exec` aninhado aplicava policy/permissão parcial, mas podia desviar de pinning, goal gate, `toolGate`, pre-read e task scope do dispatch direto. | Dispatch aninhado reutiliza os mesmos gates e IDs normalizados. Em `ENFORCE`, patch de input que ainda não possa ser reavaliado integralmente falha fechado; constraints/grants inválidos também. |
| 22 | Autoridade do claim em memória | O registry de resume mantém o estado `resuming` até o executor concluir e recusa concorrência (`claude-code-src/agent/loop.js:580-617`). | TTL/LRU de `RecentMessageKeys` podia expirar ou expulsar um owner ainda pendente; uma espera longa se confundia com conclusão e a admissão durável seguinte podia ganhar. | Owner pendente só sai por settlement/rejeição explícita ou morte do processo. Waiter tem teto curto independente do TTL, retorna `Retry-After`; capacidade cheia recusa antes do claim durável e só entradas prontas participam do LRU. |
| 23 | Fronteira RPC do Company | O transporte desktop recuperado troca envelopes JSON/`stream-json`, tornando explícita a necessidade de dados serializáveis (`claude-code-src/agent/loop.js:3198`). | O proxy main→worker era tipado como a classe síncrona real: `Promise` virava boolean truthy, faltavam `await`s e métodos prometiam `AbortSignal`, driver, runner, callback ou handles não clonáveis. | `WorkerBackedOrchestrator` é uma projeção assíncrona recursiva; só `companySessionId` e `metaBus` são locais. APIs públicas retornam DTOs clone-safe, removem authority viva da superfície e cancelamento não cruza `MessagePort`. |
| 24 | Entrega de prompt humano | ClaudeOpen associa a retomada à identidade persistida e não presume que trabalho em voo sobreviveu ao restart (`claude-code-src/agent/loop.js:580-697,1116-1120`). | Plan/question podia ser marcado `answered` antes de `provideUserInput`; duas requisições concorrentes entregavam duas vezes e ACK perdido deixava resposta persistida sem prova de entrega. | Migration 260 reserva atomicamente `pending→delivering` com token+payload hash. Um lock cobre claim→RPC→CAS; recusa pré-efeito libera o claim, ACK/CAS perdido vira `outcome_unknown`, retry comum não redelivery e retry explícito exige payload idêntico e confirmação. |
| 25 | ACK perdido em mutação Company | O snapshot declara tarefas background perdidas no restart em vez de prometer replay invisível (`claude-code-src/agent/loop.js:1116-1120`). | `port_closed`, timeout ou resposta não serializável podiam disparar retry automático/rollback destrutivo mesmo se start/resume/service/spawn já tivesse ocorrido no worker. | Mutação sem ACK é `OUTCOME_UNKNOWN`, o proxy stale é evicted e não há replay/rollback presumido. Delete/abort aguardam o fence do worker; DTO de sandbox impede que um driver escape e provisionamento usa ceiling RPC coerente com os 420–600 s já permitidos pelos drivers. |
| 26 | Verdade terminal única | Fim sem resultado vira `stream_ended_no_result` e outcome `failed`, não sucesso cosmético (`asar-src/sessions/permissions/index.chunk-BIMQN2pr.js:8354-8388`). | `transcriptFlushed` publicava sempre `done`; `recovery_capped`, doom loop e falhas de compactação podiam terminalizar o ledger default-off como sucesso. O renderer de `error` não limpava todo estado do run. | Um classificador compartilhado governa runner, worker, bus, AgentRun, ledger, comparator e renderer: só `completed` é sucesso; budgets são `interrupted`, abort é cancelado e todo motivo desconhecido/failure-class falha fechado como `error` com `message`. |
| 27 | Identidade estável do primeiro comando | A identidade de resume vem de metadata persistida, não da contagem mutável do transcript (`claude-code-src/agent/loop.js:624-880`). | O mesmo POST `/messages` era `start` com count=0 e `send_message` após o append; remount/retry podia criar dois command IDs para uma chave. | Todo `/messages` não-resume é `send_message`; `resume` permanece distinto. O lookup transacional considera `start` como alias legado para rolling upgrade e sempre continua pelo command/correlation ID realmente persistido. |

## Restrições de privacidade e rollout

- O command ledger guarda fingerprint/hash e metadata mínima; conteúdo, base64,
  tool input/result e transcript não entram no journal.
- Checkpoints de resume/workflow ficam no DB privado de sessão/projeto, têm
  cascade por sessão, expiração e teto por tipo.
- Features de AgentRun, hook e journal continuam nos flags de rollout
  existentes. O caminho default deve permanecer equivalente quando o flag está
  desligado; ativação exige migrations aplicadas e reinício do backend/worker.
- Slow consumer perde apenas sua conexão. O bus continua com replay limitado e
  o cliente retoma pelo último evento realmente consumido.
- Em `ENFORCE`, ferramentas mutantes externas/plug-ins sem um effect boundary
  atestado não executam. `SHADOW` e default-off mantêm o caminho legado.
- Fencing cancela operações cooperativas e impede novas mutações depois da
  perda de authority; ele não desfaz um efeito externo que já terminou.
- Uma entrega `outcome_unknown` nunca é repetida automaticamente. A recuperação
  humana exige confirmação explícita e o mesmo payload; isso aceita
  conscientemente o risco residual de duplicação quando o ACK foi perdido.
- RPC mutante Company com conexão perdida não aciona rollback destrutivo:
  container, child, pipeline ou agente podem já existir. Reconciliar o estado
  persistido é uma operação posterior e separada.

## Gate de validação

O lote só pode ser considerado concluído quando testes focados cobrirem:

1. EOF limpo → reconnect; EOFs repetidos → erro tipado; `done/error` → terminal.
2. Coalescing por identidade e flush em fronteira/terminal.
3. Overflow por bytes/itens, disconnect isolado, ordem de heartbeat e drain
   terminal limitado.
4. Dois POSTs concorrentes → um claim/um efeito; conflito de payload; replay
   running; terminal sem reexecução; restart sem `WeakRef`.
5. Journal lento não atrasa a publicação e overflow não cresce memória.
6. `waitMode` foreground/background e resolução completa do child `AgentRun`.
7. Fence stale impede provider/tool/terminal antes do efeito.
8. Resume após reabrir o store e duas aquisições concorrentes aceitam uma.
9. Workflow após reabrir o store não reexecuta step `completed`.
10. HookBus default-off, ordem, timeout/erro e estágios reais.
11. `taskScope` real e fixture de privacy com migrations 255 + 256.
12. Telemetria de attempt sem dupla contagem em sucesso, erro, abort e retry.
13. Company concorrente produz um efeito; conflito produz 409; restart não
    reexecuta; replay exige o `busId` exato e terminal é imediatamente visível.
14. Stream A substituído por B não altera estado/cursor de B; replay grande
    preserva ordem, faz yield e só confirma cursor depois de aplicar o evento.
15. `ping` atualiza liveness, mas nunca entra em evento semântico/transcript.
16. Crash depois do child terminal e antes do checkpoint reconcilia sem
    reexecução; outcome sem prova vira `outcome_unknown`.
17. Lease muda em uma barreira antes da syscall: zero write/spawn/request; tool
    sem boundary é recusada somente em `ENFORCE`.
18. Onze minutos sem eventos mantêm a lease raiz; timer antigo não renova um
    replacement e falha de renew impede terminal inconsistente.
19. Cap=3 com dez eventos no live tail preserva os dez; somente estado antigo
    reconstruível é podado.
20. Budget UI ausente expira para `cancel_pending` e não deixa wait slot aberto.
21. Tool aninhada percorre pinning/goal/tool/pre-read/task/policy/permission/hook;
    input patch não reavaliável e constraint/grant inválido recusam em `ENFORCE`.
22. TTL e pressão de LRU não removem owner pendente; waiter expira sem
    terminalizá-lo; cap cheio responde 503 antes de qualquer efeito/claim durável.
23. Proxy Company exige `await`; DTO de sandbox passa `structuredClone` e
    driver/runner/callback/`AbortSignal` não fazem parte do contrato main-side.
24. Duas respostas concorrentes produzem uma entrega. `false` mantém pending;
    ACK/CAS perdido persiste unknown; retry normal bloqueia e explícito exige o
    mesmo hash.
25. `port_closed`, `request_timeout` ou `unserializable_response` após mutação
    retornam `OUTCOME_UNKNOWN`, fazem eviction e não repetem nem desfazem o
    efeito; delete aguarda worker fenced antes de apagar DB.
26. Failure-class cruza worker→bus→ledger como `error`; budget/abort mantêm
    classificação interrompida/cancelada e o renderer limpa approvals/processos.
27. Retry 0→1 e remount consultam o mesmo `send_message`; uma linha histórica
    `start` ganha como alias sem criar command/correlation novo.

## Validação executada

As contagens abaixo são por bateria e não devem ser somadas: algumas fixtures
aparecem em mais de uma bateria. Testes que carregam `better-sqlite3` foram
executados com Electron em modo Node, compatível com o ABI nativo instalado.

| Bateria | Resultado |
|---|---:|
| Autoridade, nested policy, idempotência Coder/Company, prompts e bridge | 26 arquivos / 319 testes |
| Contrato terminal, command alias e coalescing Coder | 12 arquivos / 107 testes |
| SSE/WS, replay, cursor, fila limitada, ownership e coalescer | 14 arquivos / 82 testes |
| Fronteira RPC Company, DTOs e outcome de mutações | 11 arquivos / 86 testes |
| AgentRun, lease, checkpoint, workflow, resume e effect fencing | 182 testes focados |
| Transporte renderer Company | 7 testes |
| Reserva de prompt stranded/restart | 3 testes |
| Gate de orçamento sem UI | 6 testes |
| Marcador terminal de providers + tentativas persistidas | 5 testes |
| TypeScript do monorepo | `pnpm exec tsc --noEmit --pretty false` limpo |
| Dashboard | build Vite de produção limpo |
| Integridade do patch | `git diff --check` limpo; somente avisos LF→CRLF |

Não houve restart do backend/Electron, migração do banco ativo nem benchmark
live de throughput/latência nesta execução. Portanto, os contratos e builds
estão validados, mas a prova operacional com tráfego real continua sendo um
gate posterior ao restart controlado.
