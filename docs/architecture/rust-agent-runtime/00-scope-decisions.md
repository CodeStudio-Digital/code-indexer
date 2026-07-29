# 00 — Escopo, decisões e ownership

> **Status:** normativo  
> **Depende de:** contratos atuais do control plane  
> **Bloqueia:** todo código Rust de produção

## 1. Problema

O runtime atual usa um isolate V8 por sessão ativa e replica módulo, stores,
providers, registries e estado de execução. Subagentes multiplicam runners,
contextos e históricos no mesmo fault domain. Limites de old-space não cobrem
todo o commit nativo/externo e não fornecem hard isolation por run.

O novo runtime DEVE atacar o termo de crescimento por sessão/agente. Ele não é
responsável por corrigir a baseline de memória do Electron, renderer, GPU ou
serviços persistentes do host.

## 2. Objetivos

### SCOPE-001 — Runtime nativo independente

Construir um data plane Rust que execute o loop, budgets, compactação,
subagentes e tools nativas sem carregar `packages/code-agent`.

### SCOPE-002 — Isolamento single-tenant

Cada attempt, raiz ou filha, DEVE possuir processo e resource group exclusivos.
Duas attempts não podem compartilhar heap mutável ou fault domain.

### SCOPE-003 — Estado frio fora da RAM

Transcript completo, resultados grandes, checkpoints e artefatos DEVEM viver
em storage limitado. O runner mantém apenas a janela necessária ao turno.

### SCOPE-004 — Compatibilidade observável

O novo runtime DEVE preservar outcomes e invariantes de produto, não classes,
closures ou detalhes internos do runner TypeScript.

### SCOPE-005 — Retirada completa do legado

O desenho DEVE permitir remover o worker/runtime legado depois do cutover. Uma
camada permanente de tradução para `CoderRunner` não é aceitável.

## 3. Não objetivos

- Corrigir leaks ou lifecycle do `packages/code-agent` como estratégia final.
- Portar Electron, dashboard, Hono ou stores de produto não relacionados a
  sessão para Rust.
- Permitir que Rust abra o SQLite central.
- Reimplementar todos os providers antes do primeiro canário.
- Tornar `code_exec` parte do processo persistente do agente.
- Prometer redução da baseline de memória do renderer/main Electron.
- Obter paridade por cópia linha a linha do comportamento incidental legado.
- Chamar `node:vm`, containers ou processos locais de sandbox sem threat model.

## 4. Terminologia

| Termo | Definição |
|---|---|
| Session | Conversa durável; não possui processo dedicado |
| SessionCommand | Intenção idempotente aceita pelo control plane |
| AgentRun | Execução lógica causada por command ou por outro run |
| AgentRunAttempt | Tentativa física autorizada por lease e fencing |
| Root attempt | Attempt do root `AgentRun` de um command |
| Run-tree | Root `AgentRun`, todas as suas attempts, child runs e subprocessos sob um orçamento agregado |
| Supervisor | Processo Rust permanente que admite, lança, monitora e mata runners |
| Runner | Processo Rust single-tenant que executa uma attempt |
| Host | Backend TypeScript que possui DB, providers, plugins e integrações |
| Provider Gateway | API host-owned para request/stream/cancelamento de provider |
| ToolHost | API host-owned para capabilities ainda não nativas |
| Resource group | Job Object, cgroup ou mecanismo equivalente por attempt |
| Hot window | Parte limitada de contexto/transcript mantida no heap |
| Spool | Store content-addressed de bytes grandes e streams |
| Checkpoint | Estado privado suficiente para criar nova attempt |
| Durable barrier | Ponto em que terminal/checkpoint está persistido e ACKado |

## 5. Decisões de arquitetura

### D-RUST-001 — Rust é o runtime-alvo

- **Escolha:** Rust/Tokio para supervisor e runner.
- **Motivo:** ownership explícito, tipos cross-thread verificáveis e melhor
  controle de memória; isolamento de processo continua sendo o backstop.
- **Consequência:** toolchain, supply chain, signing e builds multiplataforma
  fazem parte do gate, não de trabalho posterior.

### D-RUST-002 — Processo por `AgentRunAttempt`

- **Escolha:** processo exclusivo por attempt, root ou filha, nunca shard
  multi-tenant.
- **Motivo:** limite imposto pelo SO, blast radius por run e atribuição por PID.
- **Consequência:** cold start e concorrência precisam de admission control.

### D-RUST-003 — Supervisor sem estado de agente

O supervisor PODE manter:

- tabela pequena de attempt → PID/resource group/pipe;
- budgets reservados;
- heartbeats e deadlines;
- handles de processo/Job;
- métricas e fila de admissão.

O supervisor NÃO DEVE manter:

- transcript, messages ou prompt;
- catálogo inteiro de tools por sessão;
- provider client;
- DB connection de domínio;
- resultado integral de tool;
- grafo de `AgentRunner` ou subagente.

### D-RUST-004 — Attempt é a unidade de authority

Toda mensagem de efeito DEVE carregar:

- `session_id`;
- `command_id`;
- `agent_run_id`;
- `attempt_id`;
- `executor_owner_id`;
- `fencing_epoch`;
- `operation_id`;
- `correlation_id`.

Processo novo implica attempt nova, exceto processo ainda não atribuído do pool
prewarmed. Um processo atribuído nunca recebe outra attempt.

### D-RUST-005 — Attempt isola; run-tree limita o agregado

Todo subagente visível e durável é um child `AgentRun`, recebe attempt e processo
próprios. Concorrência interna que não possui identidade de `AgentRun` PODE usar
tasks locais, mas não pode ser apresentada como subagente retomável. O orçamento
do root limita o agregado de todos os processos descendentes.

### D-RUST-006 — TypeScript continua control plane

O host mantém:

- decisões de command, AgentRun, attempts, leases e fencing;
- Policy Engine, approvals e grants;
- Environment Broker e Workspace Lease;
- Provider Gateway;
- plugins, MCP, browser, preview, LSP, docs, memória, Company e App Studio;
- projeções SSE/WebSocket e dashboard.

O Host não precisa implementar a escrita física desses fatos. Para bundles
`rust_fs_v1`, ele solicita commits ao `agent-session-store` e só publica a
transição depois do receipt durável.

### D-RUST-007 — SQLite não é session store

Rust NÃO DEVE abrir o SQLite central. SQLite pode continuar armazenando
catálogos compartilhados não pertencentes a sessão, sob seus owners atuais.
Runtime de Coder/Company/App Studio/Sprite, journal, métricas, outputs,
checkpoints e overrides de sessão pertencem exclusivamente ao bundle
filesystem.

A atribuição histórica do bundle ao Host TypeScript está supersedida por
`D-RUST-029` e pela
[ADR-001](./ADR-001-rust-session-filesystem-authority.md).

### D-RUST-008 — Provider permanece no host na V1

O runner compõe a request normalizada e recebe um stream bounded. O host possui
credenciais, OAuth, discovery, retry específico e fallbacks. O gateway NÃO
DEVE acumular uma segunda resposta completa.

### D-RUST-009 — `code_exec` é processo descartável

O runner coordena `code_exec`, mas JavaScript executa fora do runner e do
supervisor. O processo fica no resource group da attempt, com timeout, memória,
process count, output e disco limitados.

### D-RUST-010 — Protobuf é a autoridade cross-language

O `.proto` versionado substitui types TypeScript como wire authority. O pacote
TypeScript atual continua como domínio/adapters até a convergência.

### D-RUST-011 — Terminal exige barreira durável

O runner propõe terminal, mas só encerra como confirmado após ACK do Host
ligado ao receipt durável do Rust session store. Se ACK/receipt for perdido
após possível efeito, o estado é reconciliado por IDs/hash; mutação nunca é
repetida automaticamente.

### D-RUST-012 — Legado é oracle temporário

O runtime TypeScript PODE ser usado para:

- gerar fixtures e golden traces;
- comparação shadow;
- fallback de cohort não migrado;
- rollback durante rollout.

Ele NÃO DEVE receber novos conceitos de arquitetura para se aproximar do Rust.

### D-RUST-013 — Migração usa fachada e roteamento por attempt

Todo entry point de produto passa por uma fachada host-owned neutra. A geração
`legacy_ts | rust_v1` é persistida antes do launch e vale por toda a attempt.
Não existe transferência de attempt ativa nem fallback Rust → legado no data
plane.

### D-RUST-014 — O package legado deve virar uma folha

Contratos, providers, stores, parsers, prompts e helpers compartilhados são
extraídos para seus owners antes da retirada. No fim do rollout, somente o
adapter legado pode depender de `packages/code-agent`; a allowlist de imports
externos encolhe até zero.

### D-RUST-015 — Retirada de código e de dados são separadas

Workers, executor, bundles e dependências mortas são removidos depois do drain.
Dados de produto e migrations históricas são preservados. Bridges/schema
runtime-only só são contraídos em release posterior, com manifest de
disposição, backup/restore e prova sobre bancos implantados.

### D-RUST-016 — Criação Windows é atomicamente contida

Runner e descendants Windows entram no Job Object durante `CreateProcessW`
por `PROC_THREAD_ATTRIBUTE_JOB_LIST`. Criar o processo e associá-lo depois com
`AssignProcessToJobObject` não é fallback permitido. Qualquer falha
pós-criação preserva ownership linear do grupo e da reserva até prova de reap.

## 6. Decisões históricas supersedidas

| Decisão histórica | Tratamento |
|---|---|
| Preservar BT runner como motor | Supersedida para o novo runtime; válida apenas no legado |
| Ownership de child attempt pelo worker pai | Supersedida no cutover; owner passa a ser executor físico |
| Rust apenas como kernel Node-API | Supersedida pelo objetivo atual de memória e isolamento |
| Worker V8 por sessão como isolamento | Substituído por processo/resource group por attempt |

As demais decisões sobre journal, policy, idempotência, capabilities, memória e
durabilidade permanecem.

## 7. Ownership por bounded context

| Recurso | Owner | Observação |
|---|---|---|
| Decisão de session/command/run/attempt | Host | Autoridade semântica |
| Lease/fencing | Host | Runner mantém snapshot e revalida |
| Processo/resource group | Supervisor | Único owner dos handles de kill |
| Loop/hot context | Runner | Destruído ao fim da attempt |
| Provider credentials/client | Host | Nunca serializado para runner |
| Capability descriptor snapshot | Host → runner | Imutável e hashado |
| Policy decision/grant | Host | Binding selado, curto e versionado |
| Native tool execution | Runner/child | Sob resource binding |
| Host capability execution | ToolHost | Cancelável e fenced |
| SQLite não relacionado a sessão | Owners atuais | Nunca contém runtime de sessão; Rust não abre |
| Bundle filesystem da sessão | Rust `agent-session-store` | Writer físico único por UUID/generation/epoch |
| Spool bytes | Rust spool/store | Quota, hash e ACL por sessão |
| Journal/global sequence | Rust `agent-session-store` | Source durável de lifecycle |
| SSE/WebSocket | Host | Projeção, nunca authority |

## 8. Invariantes globais

1. No máximo uma attempt ativa com authority para cada `AgentRun`.
2. Processo sem lease válida não executa provider, tool ou terminal commit.
3. Processo atribuído é single-tenant e single-attempt.
4. Nenhuma fila cross-process é ilimitada.
5. Nenhum output grande precisa existir simultaneamente inteiro em dois heaps.
6. Nenhum `stdout`/`stderr` filho deixa de ser drenado por backpressure da UI.
7. Cancelamento de controle não compete atrás de bytes de output.
8. `completed` é o único sucesso terminal.
9. Mutação sem ACK é `outcome_unknown`.
10. Perda do supervisor encerra todos os run-trees que ele possui.
11. Espera humana não exige manter runner residente.
12. Retomada cria nova attempt e usa checkpoint durável.

## 9. Requisitos de scaffold

### SCOPE-006 — Cargo workspace

`native/agent-runtime` DEVE ser um Cargo workspace.

### SCOPE-007 — Toolchain

A versão mínima de Rust DEVE ser pinada em `rust-toolchain.toml`.

### SCOPE-008 — Dependency lock

O lockfile DEVE ser versionado.

### SCOPE-009 — Supply chain

A policy de crates, licenças e auditoria de supply chain DEVE ser definida.

### SCOPE-010 — Targets

Builds Windows x64/arm64, macOS x64/arm64 e Linux x64/arm64 DEVEM existir para
toda plataforma declarada como suportada pelo produto.

### SCOPE-011 — Packaging

Binaries DEVEM ser assinados, verificados e empacotados pelo pipeline do
Electron.

O pacote nativo DEVE conter somente o target da build e ficar fora do ASAR em
`resources/native-agent-runtime/<target-triple>`. `agent-runner` e
`agentd-supervisor` DEVEM estar ligados por um manifest determinístico a
target, versão do contrato, commit fonte, tamanho e SHA-256. O `buildId` DEVE
ser derivado desse conteúdo, nunca de relógio ou estado local.

O manifest e seu sidecar não constituem raiz de confiança por estarem ao lado
dos executáveis. O pipeline DEVE embutir no ASAR um anchor contendo target,
`buildId` e SHA-256 do manifest. O Host DEVE validar anchor, manifest, nomes,
tamanhos, hashes e arquivos regulares sem links antes do spawn, em modo
fail-closed. Assinatura de código, verificação da build instalada e execução em
path somente leitura pertencem a `GATE-PKG-01`; hash local não as substitui.

Nas builds Windows e macOS, o Electron DEVE habilitar conjuntamente
`EnableEmbeddedAsarIntegrityValidation` e `OnlyLoadAppFromAsar`; sem as duas
fuses, o anchor dentro do ASAR não é uma raiz confiável. Linux DEVE possuir
assinatura destacada/verificável do release e proteção do diretório instalado
definidas antes de ser declarado suportado.

Um modo diagnóstico de package smoke PODE existir nos executáveis, desde que
exija flag e token efêmero, não crie authority, endpoint, sessão, provider,
tool, subprocesso ou estado persistente e mantenha a execução normal
fail-closed. Ele só pode anunciar readiness e aguardar término físico.

O harness de `GATE-PERF-01` DEVE ser uma feature de compilação não empacotada,
usar target directory isolado e exigir flag mais token efêmero. Ele PODE criar
somente a authority sintética necessária para percorrer o driver real até
`AttemptPrepared`; NÃO PODE enviar `ActivateAttempt`, adquirir
`ActiveAuthority`, chamar provider/tool ou persistir sessão. A build normal sem
a feature continua fail-closed.

### SCOPE-012 — Cohort

O host DEVE possuir feature flag de cohort e kill switch de admissão.

### SCOPE-013 — Independência

O runtime Rust NÃO DEVE importar `packages/code-agent`.

### D-RUST-017 — commit do frame precede estado e authority

- **Escolha:** handlers produzem planos opacos; apenas o driver que possui
  sessão e transporte pode instalá-los, após receber do canal um receipt
  não-forjável ligado ao mesmo `PendingInbound`.
- **Razão:** validação sem commit deixa lifecycle/authority sobreviverem a
  reject, write failure, poison ou queda da conexão.
- **Consequência:** bootstrap, receiver e transporte possuem handoff e poison
  conjuntos; sessão e canal estabelecidos não podem ser extraídos do driver.

### D-RUST-018 — admissão de efeito sem TOCTOU

- **Escolha:** provider, tool, child spawn e mutação recebem um permit RAII
  emitido por uma closure síncrona no mesmo gate usado para revogar.
- **Razão:** `is_active` ou `authorize() -> ()` permite revogação entre a
  checagem e o dispatch.
- **Consequência:** o permit não é clonável nem atravessa `await`; o broker
  registra a operação antes de soltar o gate e usa clock confiável do driver.

### D-RUST-019 — autoridade única do header de saída

- **Escolha:** um owner privado por direção gera header, sequence, relógio e
  correlação; handlers fornecem somente payload e política de deadline.
- **Razão:** aceitar `FrameHeader` do caller permite gap, duplicata, relógio
  forjado e quebra IPC-010 mesmo com payload válido.
- **Consequência:** falha de write não publica sequence; replay físico usa os
  mesmos bytes sem avanço, enquanto retry semântico recebe novo header/sequence.

### D-RUST-020 — caches limitados por entradas e bytes

- **Escolha:** replay/tombstones têm limites de count e bytes físicos; outcome
  e replay físico usam o mesmo buffer imutável vinculado ao canal.
- **Razão:** 4.096 outcomes de 256 KiB cabem num limite por entradas e ainda
  retêm aproximadamente 1 GiB.
- **Consequência:** falta de budget fecha a conexão; clone de frame proporcional
  em cada replay é proibido.

### D-RUST-021 — nenhuma operação pendente sem reaper

- **Escolha:** hidratação e demais fases pendentes possuem abort explícito,
  deadline observado pelo clock do owner e hard timer no supervisor.
- **Razão:** token perdido ou task travada não pode manter worker, manifests e
  heap até reiniciar o app.
- **Consequência:** timeout/abort rejeita o pending, limpa estado e força exit.

### D-RUST-022 — efeito público exige broker cancelável

- **Escolha:** token/dispatch ficam internos até um broker registrar o handle
  sob o gate e revogar fila e operações in-flight.
- **Razão:** uma closure que apenas enfileira recria TOCTOU depois do retorno.
- **Consequência:** o slice de handshake permanece fail-closed para efeitos; a
  API só abre junto com os testes adversariais de revoke/dequeue/cancel.

### D-RUST-023 — connection nasce antes do processo

- **Escolha:** o host provisiona endpoint e `expectedConnectionId` antes do
  spawn; esse ID é imutável no launch, AgentHello, HostHello e handoff.
- **Razão:** aceitar connection escolhida apenas por um HostHello autoconsistente
  permite transplantar bootstrap/seed para outro endpoint.
- **Consequência:** conexão A seguida de Hello B envenena o stream; reconnect
  cria novo launch/attempt, endpoint e connection ID.

### D-RUST-024 — handshake pertence ao owner físico

- **Escolha:** uma fachada bootstrap single-use possui sessão, reader, writer,
  sender authority e clock monotônico; apenas ela publica as transições dos
  dois Hello e fornece tempo às fases seguintes.
- **Razão:** `agent_hello_sent(&message)` permite sintetizar handshake sem
  provar que sequence 1 foi escrita no mesmo stream.
- **Consequência:** sessão, métodos crus de handshake e callbacks de clock são
  internos; a fachada pública retorna apenas o driver estabelecido ou erro
  fail-closed.

### D-RUST-025 — endpoint local possui owner e peer físicos

- **Escolha:** o host sela identidade, nome lógico, connection ID e token; o
  supervisor entrega o contexto somente por bootstrap capability-only com
  conjunto exato de handles/FDs. No Windows, esse bootstrap usa dois pares de
  Named Pipes privados, single-use, com nomes aleatórios nunca serializados:
  as pontas do supervisor são overlapped/canceláveis e as pontas síncronas do
  child entram exclusivamente pela `HANDLE_LIST`. `CreatePipe` síncrono fica
  restrito a probes, nunca ao provisioner de produção. O runner já contido cria
  os três Named Pipes de control/data/pulse single-instance com DACL do logon e
  só anuncia readiness depois disso; o host verifica o PID exato do runner.
  Herdar um pipe criado pelo supervisor é proibido porque
  `GetNamedPipeServerProcessId` continua atribuindo o servidor ao processo
  criador. No Unix, o supervisor pode criar e `bind()` os sockets no pathname
  privado, mas transfere os FDs ainda sem `listen()`; o runner chama `listen()`
  após o handoff, preservando peer PID/UID exatos e a identidade `dev + ino`. O
  bootstrap secreto usa esses handles privados/socketpair, nunca argv/env.
- **Razão:** validar apenas endereço/token em Protobuf não prova localidade,
  exclusividade, peer, rollback nem ownership físico; também aceita UNC, alias
  de caixa, symlink e receipt somente com hashes. Criar ou escutar no processo
  errado sela a identidade física errada mesmo que o handle/FD seja transferido.
- **Consequência:** endpoints e cleanup são owners não clonáveis. Primeiro peer
  errado, timeout, cancel ou erro revoga sem retry; cleanup não provado retorna
  ownership ao reaper. No Windows, operação overlapped pendente retém
  `OVERLAPPED`, evento, buffer e handles até a conclusão/cancelamento ser
  comprovada; nenhum worker destacado pode possuir esse estado.
  `RunnerEndpointsReady` só existe depois da criação/listen no runner contido,
  e o supervisor continua fora do data path host↔runner.

### D-RUST-026 — bootstrap do runner possui wire e owner próprios

- **Escolha:** `runner_bootstrap.proto`, fora de `ManagementPayload` e
  `FramePayload`, define um único `RunnerLaunchHandoff` seguido por um único
  `RunnerEndpointsReady`. O ready reconhece o SHA-256 domain-separated dos
  bytes exatos do handoff. Rust transfere o wire gerado clonável imediatamente
  para owners não clonáveis: o envio consome
  `PreparedRunnerLaunchHandoff` e produz `AwaitingRunnerEndpointsReady`, sem
  accessor reutilizável para o frame secreto. O decode produz somente um owner
  de forma/autoconsistência validada, não uma prova de `LaunchPlan`, relógio,
  plataforma, PID/UID, HANDLE/FD ou ownership físico. Tokens crus são apagados
  após o decode e permanecem somente como hashes privados ligados ao endpoint;
  o launch nonce cru permanece em owner `zeroize` single-use até a gravação e o
  commit de `AgentHello`, sendo então apagado também em sucesso, erro ou drop.
  O activation nonce cru permanece no host; o supervisor encaminha apenas um
  `ActivationAuthoritySeal` host-minted, validado e ligado aos bytes exatos do
  handoff, para o runner comparar antes de publicar `ActiveAuthority`.
- **Razão:** reutilizar o management oneof mistura lifecycles e permite que uma
  mensagem permanente seja confundida com autoridade de bootstrap. Re-encode
  antes do hash perde unknown fields; reter tipos gerados com segredos permite
  clones acidentais e lifetime maior que o processo. `Vec::fill(0)` não fornece
  garantia contra otimização; scrubbing usa a dependência auditada `zeroize`,
  sem `unsafe` próprio fora de `agent-platform`.
- **Consequência:** handoff e ready têm caps físicos separados de 64 KiB e
  4 KiB, respectivamente, e todo token efêmero de sessão ou endpoint possui
  16..512 bytes. EOF, frame extra, enum desconhecido, mapa divergente ou digest
  incorreto falham sem retry. `RunnerEndpointsReady` é evidência de wire, não
  receipt de ownership. Sucesso exige Ready exato, EOF, I/O de bootstrap
  comprovadamente encerrado, validação contra `LaunchPlan`, relógio/plataforma
  reais e prova física dos peers/handles. Registrar I/O ainda pendente no
  reaper é exclusivamente caminho de falha/cleanup e nunca habilita o launch.
  Falha de completion sempre transfere um cleanup owner linear ligado à mesma
  `OwnershipKey`; o reaper termina o Job, comprova o cleanup de I/O sem bloquear
  e só então faz o reap físico e devolve admissão. Retry possui limite; stall
  fecha admissão e exige restart duro preservando o owner. Drop acidental de
  operação ainda pendente é process-fatal e limitado, nunca espera infinita nem
  libera memória referenciada pelo kernel. Somente Job/listeners vivos seguem
  registrados no lifecycle normal.

### D-RUST-028 — shutdown é transacional, bounded e monotônico

- **Escolha:** `ShutdownSupervisor` fecha admission antes do ACK e possui dois
  modos. `Drain` preserva schedules por attempt e instala um ceiling global;
  owner sobrevivente ao ceiling exige hard restart com ownership retido.
  `TerminateAfterGrace` agenda todos os owners por mínimo e remove o ceiling de
  drain. Termination pode escalar drain; drain posterior é subsumido.
- **Razão:** usar uma única política apagaria a diferença entre convergência
  cooperativa e ordem física de termination. ACK anterior à mutação permitiria
  que o Host observasse shutdown aceito enquanto o supervisor ainda admitisse
  trabalho. Estado ou retries sem limite recriariam a retenção que o runtime
  nativo deve eliminar.
- **Consequência:** o ledger usa no máximo um slot por modo. Replay físico é
  byte-identical; retry semântico exige chave e digest idênticos; conflito falha
  fechado. Write cancelado permanece owned e retomável, write failure não
  desfaz admission/deadlines e o loop continua consumindo management durante
  drain enquanto serializa o lifecycle no mesmo owner.

### D-RUST-029 — Rust possui a authority física do bundle de sessão

- **Escolha:** `agent-session-store` é o único writer físico de bundles
  `rust_fs_v1`. Ele possui fila e lease fenced por sessão, atribui
  `globalSeq`, encadeia hashes, promove artifacts/checkpoints, publica
  projeções e metric rollups e executa recovery/GC. O Host TypeScript mantém
  decisões de produto, policy, provider e UI, mas só confirma transições após
  receipt durável do store. Supervisor, runner e `code_exec` nunca recebem
  paths de bundle.
- **Razão:** a arquitetura filesystem retirou o runtime de sessão do SQLite e
  eliminou o travamento observado. Reimplementar journal, recovery, quotas e
  métricas no Host manteria metade do lifecycle no runtime que será removido e
  criaria dois owners depois do cutover.
- **Consequência:** `storageGeneration` pertence ao manifesto imutável da
  sessão; cada `leaseEpoch + writerId` pertence ao authority log append-only e
  hash-chained referenciado pelo manifesto. A transferência
  `typescript_fs_v1 → rust_fs_v1` exige drain, verificação e avanço fenced do
  epoch; não existe dual-write nem fallback ao writer TypeScript depois da
  ativação. A fronteira e os gates completos estão na
  [ADR-001](./ADR-001-rust-session-filesystem-authority.md).

## 10. Gate deste documento

Antes de iniciar implementação funcional:

- todas as decisões D-RUST devem estar aceitas;
- o layout deve estar confirmado;
- a unidade `AgentRunAttempt` deve estar refletida no IDL;
- ownership de DB, provider, policy, spool e processo deve ter exatamente um
  owner;
- qualquer exceção deve existir como ADR no mesmo diretório.
