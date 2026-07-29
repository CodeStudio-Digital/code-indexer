# Checklist mestre — Rust Agent Runtime

> **Status inicial:** nenhum gate aprovado  
> **Atualização:** este é o único arquivo do corpus em que checkboxes de avanço
> são alterados.

“Spec final” significa texto normativo congelado; não significa implementação
concluída. Por isso todos os checks começam vazios até owner e evidência serem
registrados.

## 1. Regra de marcação

Marque um item somente quando:

1. a implementação correspondente existe;
2. os testes automatizados exigidos passam no commit candidato;
3. a evidência runtime/benchmark/chaos solicitada foi registrada;
4. nenhum stop condition relacionado permanece aberto.

Ao marcar, preencha `Evidência` com links ou paths imutáveis e identifique
commit/build, plataforma e data quando aplicável. Não marque itens em massa pela
existência de um PR. O checkbox de gate é sempre o último da fase.

## 2. Estado das fases

| Fase | Estado inicial | Gate proprietário |
|---|---|---|
| G0 — spec e baseline | não iniciado | `MIG-011` |
| G1 — workspace, IDL, storage foundation e build | em andamento | `MIG-012` |
| G2 — supervisor e isolamento | não iniciado | `MIG-013` |
| G3 — engine e provider | não iniciado | `MIG-014` |
| G4 — tools e capabilities | não iniciado | `MIG-015` |
| G5 — durabilidade e subagentes | não iniciado | `MIG-016` |
| G6 — shadow, chaos e canário | não iniciado | `MIG-017` |
| G7 — default, drain e limpeza | não iniciado | `MIG-024` |
| GI — indexador nativo, I0–I4 (doc 09) | não iniciado | `IDX-GATE-4` |

## 3. G0 — spec, ownership e baseline

- [ ] `G0-SPEC-01` — Corpus `README`, `DECISIONS` e specs `00..08` revisado e
  aceito como autoridade.
  - Spec: `SCOPE-001..013`, `D-RUST-001..029`, `MIG-011`
  - Evidência:
- [ ] `G0-SPEC-02` — Nenhuma decisão bloqueadora permanece aberta sobre Rust,
  process-per-attempt, Host TS, filesystem session store, SQLite, provider V1,
  IDL, `code_exec`, fachada de migração ou separação código/dados.
  - Spec: `D-RUST-001..029`, `ADR-001`
  - Evidência:
- [ ] `G0-SCOPE-01` — Limite “sem remendos arquiteturais no code-agent legado”
  está registrado no backlog e no critério de review.
  - Spec: `SCOPE-005`, `D-RUST-012..015`, `MIG-001..010`
  - Evidência:
- [ ] `G0-OWN-01` — Owners nominais definidos para Runtime, Platform, Protocol,
  Host Adapter, Capabilities, Durability, Security, Observability, Data e
  Rollout.
  - Spec: `RUST-R001..060`
  - Evidência:
- [ ] `G0-BASE-01` — Matriz versionada de tarefas, workspaces, providers,
  tools, subagentes e falhas criada.
  - Spec: `MIG-003..006`
  - Evidência:
- [ ] `G0-BASE-02` — Harness mede árvore de processos, private/PSS, CPU, threads,
  handles, IPC, TTFT, eventos, spool e órfãos.
  - Spec: `OBS-001..008`
  - Evidência:
- [ ] `G0-BASE-03` — Baseline do legado repetida três vezes em build empacotada,
  com dispersão e ambiente registrados.
  - Spec: `MIG-002..006`
  - Evidência:
- [ ] `G0-BASE-04` — Baseline do Electron main/renderer ocioso registrada
  separadamente da árvore de agentes.
  - Spec: `OBS-002..003`, `RUST-R040`
  - Evidência:
- [ ] `G0-BASE-05` — Corpus, métricas e método estatístico do benchmark de
  eficácia foram congelados antes da implementação funcional.
  - Spec: `GATE-QUAL-01/02`, `RUST-R044`
  - Evidência:
- [ ] `G0-CUT-01` — Manifest A01–A20 lista entry points, símbolos, imports,
  dependencies, workers, scripts, flags, eventos, dados, owner e destino.
  - Spec: `CUT-001`, seção 8 de `08`
  - Evidência:
- [ ] `G0-CUT-02` — CI bloqueia novos imports/path-fonte/tipos do legado por
  allowlist versionada que só pode encolher.
  - Spec: `CUT-002`, `CUT-022`, `RUST-R045`
  - Evidência:
- [ ] `G0-CUT-03` — Contrato de `AgentRuntimeFacade`, `AgentRunHandle`,
  RuntimeRouter, IDs e projector está aprovado.
  - Spec: `CUT-003..005`, `CUT-015..020`
  - Evidência:
- [ ] `G0-GATE` — Gate G0 aprovado.
  - Spec: `MIG-011`
  - Evidência:

## 4. G1 — workspace Rust, IDL e packaging

- [ ] `G1-RUST-01` — Workspace `native/agent-runtime` criado com crates e
  dependências direcionadas como no README.
  - Spec: `SCOPE-006`, `SCOPE-013`
  - Evidência:
- [ ] `G1-RUST-02` — Toolchain Rust e lockfile fixados; `fmt`, `clippy`, testes,
  licença/audit e build release fazem parte do CI.
  - Spec: `SCOPE-007..011`
  - Evidência parcial (2026-07-25): `Cargo.lock` fixa `zeroize 1.9.0`;
    `cargo fmt --check`, Clippy do workspace com `-D warnings` e testes
    `--locked` passam. Revisão automatizada de licença/advisory e build release
    no CI candidato ainda permanecem pendentes; item continua aberto.
- [ ] `G1-RUST-03` — Quantidades de Tokio workers, blocking workers, channels e
  operation maps são explícitas e testadas.
  - Spec: `RUN-032..035`, `RUST-R005..007`
  - Evidência parcial (2026-07-26): cada launch físico usa um worker OS
    single-owner com stack explícita de 1 MiB; os canais de estágio, comando e
    cleanup têm capacidade 1. O efeito bloqueante não ocupa o loop Tokio, e
    testes determinísticos cobrem cancelamento, watchdog concorrente e shutdown.
    Ainda faltam selar e testar a configuração global de Tokio, blocking pool,
    operation maps e os leak tests de longa duração; item aberto.
- [ ] `G1-HOST-01` — `packages/agent-runtime-host` existe sem depender de
  `packages/code-agent` no contrato público; facade, router, adapters e
  projectors possuem boundaries explícitas.
  - Spec: `CUT-003`, `CUT-015..018`
  - Evidência parcial (2026-07-26): facade, router, framing IPC e lifecycle
    possuem diretórios e ports separados; `RustHostAttemptCoordinator` continua
    interno e o teste de API pública impede export acidental do driver. O
    package não importa o executor legado. Adapters/projectors de produção e a
    composição de todas as superfícies ainda são pendentes; item aberto.
- [ ] `G1-EXT-01` — Cada export consumido externamente do legado está
  classificado como `move`, `replace`, `fixture-only` ou `delete`.
  - Spec: `CUT-022`, `RUST-R045`
  - Evidência:
- [ ] `G1-EXT-02` — Prompts/assets e contracts cross-language necessários ao
  novo runtime possuem owner fora do package legado.
  - Spec: `CUT-024`, `CUT-027`
  - Evidência:
- [ ] `G1-IDL-01` — `.proto` v1 criado em
  `packages/agent-runtime-contracts/proto/codestudio/agent/v1`.
  - Spec: `IPC-001..009`
  - Evidência parcial (atualizada em 2026-07-29):
    `runner_bootstrap.proto` separa o handoff privado do management oneof;
    `runtime.proto` exige `idempotency_key = 5` também em `FenceAttempt`;
    `RunnerLaunchHandoff.runtime_provenance = 14` transporta a identidade do
    binário somente após o match confiável e a liga ao runtime/PID físicos.
    `session_store.proto` acrescenta leitura path-free do payload comprometido,
    ligada ao writer/authority/operation/kind/hash/tamanho exatos; hash isolado
    não autoriza leitura. Bindings TS/Prost foram gerados e compilados a partir
    do IDL; `buf lint` e `buf build` passam localmente. Item aberto até o CI
    candidato.
- [ ] `G1-IDL-02` — Bindings TS/Rust são gerados; nenhum tipo de wire é mantido
  manualmente em paralelo.
  - Spec: `IPC-001..002`
  - Evidência parcial (atualizada em 2026-07-26): `buf generate` regenerou
    os bindings TS e o módulo Prost compartilhado a partir dos mesmos `.proto`,
    incluindo `FenceAttempt.idempotency_key`. O plugin Prost está fixado em
    `v0.5.0`, `revision: 1`, e uma segunda geração preservou hashes SHA-256
    idênticos das seis saídas. Nenhum binding foi escrito manualmente.
- [ ] `G1-IDL-03` — Golden fixtures cobrem IDs opacos, `uint64`, optional/oneof,
  canonical JSON, hash, enum desconhecido e frame máximo.
  - Spec: `IPC-003..005`, `IPC-007`, `IPC-010..012`, `IPC-035`,
    `IPC-043..044`, `RUST-R014..015`
  - Evidência parcial (2026-07-25):
    os fixtures Windows, Unix e `RunnerEndpointsReady` são codificados byte a
    byte por TS e Rust; preservam fencing `uint64`, optional UID, slots,
    três endpoints e o digest domain-separated. Campo Protobuf desconhecido
    também fica ligado aos bytes originais, sem normalização por re-encode.
    Os mapas completos de tags de `CancelAttempt` e `FenceAttempt` também ficam
    fixados no teste de contrato. A suíte host/contracts passou 331 testes; o
    workspace Rust passou 410
    testes (11 helpers child/E2E ignorados por desenho), incluindo 194 de
    `agent-protocol` e 91 de `agent-runner`, mais 14 doc-tests `compile_fail`.
- [ ] `G1-IDL-04` — Lint e breaking-change detection do IDL rodam no CI.
  - Spec: `IPC-033..035`
  - Evidência parcial (2026-07-25): `rust-agent-ci.yml` executa lint, descriptor
    build, `buf breaking`, geração reproduzível e diff dos bindings. O item
    permanece aberto até o run de CI desta revisão.
- [ ] `G1-HS-01` — Hello, Prepare, Prepared e Activate funcionam nos dois
  canais; execução antes de Activate falha fechado.
  - Spec: `IPC-006..016`, `IPC-036..040`, `RUN-001..004`
  - Evidência parcial (atualizada em 2026-07-26):
    `ActivationAuthoritySeal` nasce tipado em `LaunchAttemptProcess` com
    versões e `SHA-256(raw_activation_nonce)`, é validado e copiado sem mint
    pelo supervisor para o handoff exato. O runner retém o commitment no
    `RunnerLaunchContext` e rejeita versões ou nonce divergentes antes do ACK.
    `HostHello.write_timeout_ms` agora sobrevive à negociação; o deadline do
    `ActivateAck` usa o mínimo entre attempt e timeout de write e é verificado
    antes/depois do write físico. Retorno no/após deadline, regressão de clock
    ou falha de write fecham o driver sem instalar `ActiveAuthority`.
    `RustHostAttemptCoordinator`, ainda interno e restrito a `test|shadow`,
    somente abre control depois de `LaunchAccepted → Spawned → Containment`
    duráveis e confirmados; seu `run()` só resolve depois de
    `AgentHello → Prepare → Prepared → durable grant → Activate → Ack → Active`.
    Testes cobrem ordem, cancelamento, expiry e revogação de settlement tardio.
    No runner, um owner Tokio crate-private aceita o Host fisicamente esperado
    e conduz o mesmo fluxo sobre o stream real. `Prepared` e `Active` só
    avançam depois dos writes físicos correspondentes; cancelamento, EOF,
    clock inválido, deadline, hydration failure ou future abandonada revogam
    canal/authority. Depois do ACK, `ActiveRunnerLifetime::advance` retém
    control, handoff, data e pulse no mesmo owner e conduz um evento bounded.
    `CancelAttempt` e `FenceAttempt` possuem handlers semânticos: validam
    authority e idempotência, revogam effects antes do ACK, instalam
    `Cancelling` somente após receipt físico válido e devolvem cleanup tipado
    em `Exiting`. Deadline, regressão de clock, conflito, cancelamento local ou
    abandono não restauram authority. Isso ainda não é o pump completo:
    heartbeat/pulse, drain cooperativo, cancelamento host-owned, ligação do
    cleanup/exit do processo runner ao registro físico do supervisor e E2E
    físico Host TS↔runner continuam pendentes. Atualização 2026-07-29: o `main`
    Windows de produção agora consome o bootstrap herdado, valida
    supervisor/handoff, materializa os três endpoints e entra no accept/pump
    control. A proveniência comparada pelo supervisor é encaminhada no handoff
    protegido e validada contra runtime/PID. Um E2E com Host, supervisor e
    runner em processos distintos comprova PID bilateral, `AgentHello →
    HostHello`, nonce, proveniência, negociação, estado ainda `Reserved` e reap
    a zero. O teste encontrou e corrigiu dois defeitos reais da composição:
    `EnterGuard` sobreposto ao `block_on` e timer Tokio não habilitado.
    Atualização adicional 2026-07-29: o store e o bridge Rust agora leem bytes
    comprometidos sem path somente após validar writer/authority/operation/
    kind/hash/tamanho e caps. O runner ganhou verifier/owner one-shot que exige
    cobertura exata dos snapshots/artifacts, valida metadata, SHA-256 e budgets
    selados e retém os bytes até `Active`. Atualização 2026-07-29 (spec 1.4.7):
    o runner agora materializa também o data endpoint de produção, exige
    `BindAttemptChannel` Host→runner como primeiro frame, valida o token
    endpoint-bound e responde `AttemptChannelBound` antes de expor o stream.
    O pump conduz `Manifest → Progress → Chunk/Progress → Complete/Committed`
    com stop-and-wait, digest do payload opaco, SHA de chunk/conteúdo,
    zeroization, cap de bytes e budget total de frames. Chunks devem consumir o
    crédito exato. Durante a hidratação, o loop continua atendendo control para
    replay, Cancel e Fence. Testes Tokio cobrem o bind autenticado, e a máquina
    de estados cobre a transferência completa até o commit.
    Atualização 2026-07-29 (spec 1.4.8): o Host agora possui framing
    channel-sealed Control/Data, correlação Data por request, sender
    `Bind/Bound → Manifest/Progress → Chunk/Progress → Complete/Committed`,
    source filesystem streaming e adapter físico interno `test|shadow`.
    O adapter consome owners opacos distintos de endpoint/conexão Data, liga
    reservation/resource group/runtime/PID aos fatos duráveis, exige limites
    físicos exatos, reapeia settlement tardio e mantém token/chunks
    single-use com zeroization. `prepareHydrated` grava `Prepare`, conclui Data
    e somente então admite o `Prepared` correlacionado; falha ou cancelamento
    revoga os dois caminhos. Um E2E in-memory do transporte físico prova
    bind, hidratação integral a partir da fonte de disco e commit.
    A promoção continua fail-closed: o bridge core ainda precisa ser carregado
    in-process e transferir o owner opaco sem reabrir o HANDLE/FD; o E2E Named
    Pipe Host TS↔runner ainda deve completar Prepare/Activate.
    Evidência automatizada atual: 542 testes Rust passaram/14 helpers físicos
    ignorados por desenho; os 8 E2E Windows explícitos passaram 8/8; 14
    doc-tests; contracts+Host TS 349 testes; `buf lint/build`, typecheck,
    clippy workspace `-D warnings`, rustfmt e build release verdes; LOC 578
    módulos/250 cap e grafo 9 crates/9 edges. Dois fixtures Windows antigos
    foram alinhados ao contrato vigente: IPC agora deixa crédito positivo após
    a reserva de envelope Data e proveniência não pode ser vazia. O ratchet
    global de imports legados continua vermelho por 87 referências novas e 56
    removidas da migração filesystem concorrente, fora desta fatia; o baseline
    não foi regenerado.
    Atualização 2026-07-29 (spec 1.4.9): o IDL ganhou o request único
    `HostAttemptBridgeOpenRequest`, composto por launch, fatos duráveis,
    deadline de abertura e containment requerido. O novo crate
    `agent-host-bridge` decodifica e apaga os segredos, revalida identity,
    budget, reservation, resource group, runtime, proveniência, containment,
    tempos e conjunto exato Control/Data/Pulse antes de qualquer I/O. No
    Windows, ele abre Control e Data diretamente e verifica o PID do runner no
    mesmo Named Pipe; o resultado é um owner Rust único dos dois transports.
    Divergência durável falha antes do open, PID falso é rejeitado pelo SO e
    falha ao abrir Data descarta Control. O Host TS produz esse request por um
    owner single-use e zera os bytes após sucesso, erro ou abort explícito; um
    finalizer é apenas o backstop para owner abandonado. O ADR-002 fixa que o
    próximo binding será um wrapper Node-API in-process fino, nunca sidecar,
    probe/reopen ou handle bruto em JavaScript.
    Evidência desta fatia: 545 testes Rust passaram/14 ignored; 353 testes
    contracts+Host TS; 3/3 testes físicos do novo bridge; typecheck, Protobuf
    lint/build/generate, rustfmt, Clippy estrito, 11 doctests e build release
    verdes; o caminho fail-closed também passou check/Clippy cruzado para
    `x86_64-unknown-linux-gnu`; os 8 E2E Windows opt-in passaram 8/8; LOC 587
    módulos/250 cap e grafo 10 crates/11 arestas.
    Atualização 2026-07-29 (spec 1.5.0): o crate
    `agent-host-bridge-napi` implementa o wrapper Node-API 8 in-process. Um
    owner Rust único retém Control/Data, oferece read/write em chunks máximos de
    64 KiB, impede operação concorrente por direção, compartilha cancelamento e
    fecha ambos os clientes por `close()` explícito; GC/Drop permanece somente
    backstop. Request e chunks de saída são zerados nos dois lados da ABI. O
    loader TS recebe um `VerifiedRuntimePackage`, exige ABI/contrato/target
    exatos e transfere o request opaco sem expor path, token ou HANDLE. O
    package manifest agora liga três artefatos — addon, runner e supervisor —
    por tamanho/SHA-256/build ID. Package verify e smoke read-only passaram; o
    addon carregou, provou que a classe owner não possui constructor público e
    rejeitou request inválido no Node 22 e Electron 42.5 Windows x64. Evidência
    consolidada: 545 testes Rust passaram/14 ignored;
    355 testes contracts+Host TS; 14 doctests; typecheck, rustfmt, Clippy
    workspace e Clippy cruzado Linux estritos; LOC 599 módulos/250 cap e grafo
    11 crates/12 arestas. O item permanece aberto somente até o adapter ligar
    esse owner ao framing/driver e o E2E process-real completar
    Prepare/Activate.
- [ ] `G1-HS-02` — Management é bounded e runner conecta control/data
  diretamente ao host; supervisor não recebe payload de provider/tool.
  - Spec: `IPC-036..040`, `D-RUST-003`
  - Evidência parcial (2026-07-26): management usa frame/replay/command limits
    selados, janela física de um fato aguardando ACK e processamento Host
    limitado por sequência. O handoff entrega endpoints control/data/pulse
    diretamente ao runner; o supervisor retém somente fatos de launch,
    containment e ownership, sem payload de provider/tool. O mesmo serviço
    management de biblioteca aceita múltiplos `LaunchAttemptProcess` e conduz
    Launch/Cancel/Fence/Reap. A cadeia
    `LaunchAccepted → AttemptProcessSpawned → AttemptContainmentReport` é
    correlacionada e limitada pela janela negociada. O data endpoint e o pump
    de hidratação runner-side agora são concretos, autenticados e bounded; o
    adapter do owner N-API ao framing/driver Host, pulse, composição
    multi-launch no `main` process-real, recovery e rehydration ainda são
    pendentes; item aberto. O sender Data e seu adapter `test|shadow` já
    existem, mas não são promovidos por PID ou path fornecido pelo JavaScript.
- [ ] `G1-HS-03` — Bootstrap entrega o mesmo stream a um canal estabelecido com
  cap físico exato; seed transplantado, reject, poison e write failure não
  produzem receipt de commit. Header de saída é gerado por authority única e
  replay físico não avança sequence, enquanto retry semântico gera novo header.
  Connection ID de cada stream é igual no launch, endpoint e handoff; control
  repete-o em `FrameHeader`/`HostHello`, data em `FrameHeader` do bind, e pulse
  sela-o no handle/FD autenticado sem repeti-lo em cada frame. Transições cruas
  de sessão não são públicas e a ordem dos Hello é comprovada pelo owner físico.
  - Spec: `IPC-009..012`, `D-RUST-017`, `D-RUST-019`, `D-RUST-023..027`
  - Evidência parcial (atualizada em 2026-07-26): adapters
    `agent-platform::windows::ipc` e
    `agent-platform::unix::ipc` implementam owner one-shot, deadline/cancel,
    peer PID bilateral (e UID bilateral no Unix), root UDS sem symlink e cleanup
    condicional que preserva ownership se a identidade divergir; IDL agora
    carrega `connection_id` por endpoint. O spawn Windows consome uma allowlist
    bounded de duplicatas herdáveis próprias, usa `JOB_LIST + HANDLE_LIST` e
    possui testes de inclusão/exclusão em processo real. Outro teste físico
    prova que Named Pipe herdado preserva o PID do criador, por isso D-RUST-025
    agora exige criação dos pipes pelo runner contido. O IDL
    `runner_bootstrap.proto`, o codec Rust non-cloneable, caps 64 KiB/4 KiB,
    limite de token 16..512 bytes, ownership
    `PreparedRunnerLaunchHandoff → AwaitingRunnerEndpointsReady`, scrub
    auditável, ACK do handoff exato e golden TS↔Rust também estão implementados.
    O decode é deliberadamente apenas validação de forma/autoconsistência;
    tokens viram verifiers non-cloneable ligados ao endpoint e ao hash do
    handoff exato, enquanto o nonce permanece em owner zeroizing single-use.
    O mesmo verifier do endpoint data agora só pode produzir
    `AsyncBoundDataAttemptChannel` após bind Host→runner exato; o typestate
    unbound não expõe recepção de domínio. O framing estabelecido foi
    generalizado por canal sem permitir transplante Control↔Data, e
    bind/bound possuem direções fixas e sequências independentes.
    A transição pós-Ready mantém context+verifier+nonce inseparáveis até o
    `AgentHello`; callbacks crus e split de listeners não são API pública.
    Decode parcial, early return, erro de write, panic e drop sobrescrevem
    `AgentHello`/`HostHello`, e Debug não renderiza os segredos.
    A fatia física de probe Windows agora cria dois pipes anônimos mais `NUL`,
    instala o stdio indivisível por `HANDLE_LIST + JOB_LIST` antes da primeira
    instrução, faz o runner bloquear no receiver após `ResumeThread` e comprova
    que handles alheios, argv e env não carregam a autoridade. O mesmo teste de
    processo real prova request/response, PID criador bilateral e EOF do Ready
    enquanto o runner continua vivo. O transporte exige exatamente um frame e
    EOF em cada direção; o runner verifica o PID criador antes de clock/bind,
    valida
    PID/deadline/plataforma, cria os três Named Pipes nos endereços canônicos
    exatos e só produz Ready depois dos três binds. Falha de write libera os
    listeners e permite rebind imediato dos mesmos nomes.
    Atualização 2026-07-29: outro E2E usa Host, supervisor e runner em processos
    distintos; o Host conecta pelo endereço real, verifica o PID servidor,
    recebe/valida `AgentHello` e envia `HostHello`, enquanto o runner verifica o
    PID cliente antes do protocolo. A proveniência protegida coincide com os
    fatos de spawn e Hello não altera o estado físico `Reserved`.
    Validação local desta fatia: 527 testes Rust de workspace passaram, com 14
    helpers ignorados no harness principal; 14 doctests e os cinco E2E Windows
    explícitos passaram. Também passaram 340 testes Host/contratos, lint/build
    Protobuf, rustfmt, Clippy `-D warnings`, build release, orçamento de 538
    módulos produtivos sob cap de 250 LOC e grafo de 9 crates/9 arestas. O gate
    global de boundary legado continua vermelho por drift concorrente da
    migração TypeScript filesystem (56 remoções/87 imports fora desta fatia);
    a baseline não foi regenerada para mascará-lo.
    No supervisor, `prepare → spawn contido → prova física/containment →
    complete_after_spawn` substituiu o receipt pré-spawn; handles são consumidos
    pelo registry, falha posterior agenda cleanup apenas da tentativa e
    `LaunchAccepted` não é emitido. Request/facts/seal carregam também authority
    lease e peer authority; PID/UID cru e mint de receipt não possuem construtor
    de produção, somente helpers `cfg(test)`.
    O provisioner Windows de produção cria dois pares de Named Pipes privados
    com nome CSPRNG não exposto, `FIRST_PIPE_INSTANCE`, rejeição de clientes
    remotos e DACL do logon. As pontas parent são overlapped/non-inheritable; as
    pontas child síncronas entram somente pela `HANDLE_LIST`. Um único deadline
    monotônico, derivado em `prepare` do mínimo entre hard deadline, authority
    lease e startup timeout, cobre pipe, spawn e handoff, com nova amostragem
    antes do receipt. O provisioner Windows não cria helper thread próprio; o
    pipeline físico externo executa no worker de launch dedicado.
    Falha de send/receive transfere reader, writer, `OVERLAPPED`, evento e buffer
    a `ProtectedLaunchCompletion::CleanupRequired`. O registry retém esse owner
    pela mesma `OwnershipKey`; a ordem é terminate Job → cleanup nonblocking →
    reap físico, sem devolver admissão antes da prova. Retry de cleanup possui
    limite explícito; stall fecha admissão, preserva ownership e exige restart
    duro. `Drop` de I/O ainda pendente é fail-stop e limitado, nunca uma espera
    infinita nem liberação de memória referenciada pelo kernel.
    Os E2E Windows usam helpers pertencentes a `agent-runner`, mantêm o grafo
    `supervisor → runner` proibido e provam success/Ready/EOF com o owner dos
    três endpoints ainda vivo, além de timeout+retry e cancel externo na ordem
    física terminate Job → cleanup I/O → reap.
    Dois testes adicionais percorrem o canal management e o
    `SupervisorPhysicalDriver` reais com `WindowsContainment` e
    `WindowsProtectedLaunchProvisioner`, sem fabricar fatos físicos. No sucesso,
    `LaunchAccepted` mantém o processo `Reserved` e sem autoridade de efeito
    antes de `ActivateAttempt`; EOF fecha admissão e
    `SupervisorCleanupPump::advance` termina e reapeia até ownership, memória,
    processos, cleanup registry e scheduler chegarem a zero. No timeout
    pós-spawn, `LaunchRejected` mantém exatamente um owner em `Cancelling`,
    reservation e cleanup sob a mesma `OwnershipKey`; só após cleanup I/O e
    reap o registro marca `physical_reaped`.
    O pump só aceita ownership com admissão fechada e todas as attempts
    agendadas, sela o hard deadline na transferência, preserva owner/deadline se
    seu await for cancelado e limita cada tick a um item por fase. Deadline é
    verificado antes/depois do tick, retries rotacionam em round-robin e o único
    failure outcome mantém ownership em `HardRestartRequired`.
    O framing Tokio agora amostra deadlines estritamente antes e depois de cada
    I/O, sobrescreve frame recebido tarde e cria guards RAII antes do primeiro
    poll. Testes diretos cobrem future de receive/commit nunca pollada, fechamento
    físico do peer e ausência de response write; o runner cobre também
    `AgentHello`. A leitura control pós-Active mantém silêncio entre frames
    saudável até hard deadline/cancel/EOF e aplica `read_timeout` somente ao
    progresso desde o primeiro byte; frame parcial estagnado envenena o stream.
    O mesmo `Instant` selado governa a espera externa e o framing, e uma
    verificação semântica pós-I/O impede continuar `Active` no deadline. Replay
    calcula seu deadline de write somente depois do read e qualquer
    cancelamento fecha o stream único. No Host, o adapter
    interno `test|shadow` liga reservation/resource group/runtime/provenance e
    exige cleanup `closed | native_reaper`. O core `agent-host-bridge` já cria
    owners Control/Data e verifica o peer no mesmo HANDLE/FD. O wrapper
    `agent-host-bridge-napi` já os mantém no processo Host com I/O bounded e
    cleanup explícito; D-RUST-027 ainda bloqueia produção até o adapter
    transferir esses transports ao framing/driver sem reopen.
    No runner pós-`Active`, Cancel/Fence seguem uma transação própria:
    validação → revogação síncrona → ACK bounded → reamostragem do clock →
    receipt → `Cancelling`. Testes cobrem write bloqueado/abandonado, deadline
    exato, regressão, corrida com cancelamento local, replay físico de bytes,
    retry semântico de Cancel e Fence e conflitos de payload/chave/tipo.
    No supervisor, cada launch protegido instala watchdog inicial em
    `min(hard deadline, authority lease)`. `CancelAttemptProcess`,
    `FenceAttemptProcess` e `ReapAttemptProcess` validam o target físico,
    reservam chave/digest/causa em ledger bounded antes do efeito, instalam
    schedule monotônico e somente então gravam `ManagementAck`. A precedência
    `Cancel < Fence < Reap` nunca alonga o menor deadline; Cancel respeita a
    grace solicitada e selada, Fence deriva a grace do budget selado e Reap
    torna imediatamente due também retries de termination/reap e mantém ceiling
    próprio. Replay físico, retry semântico inclusive pós-reap, conflito,
    colisão de chave entre tipos/attempts, ACK perdido, sibling isolada, stale
    identity/runtime e ceiling expirado possuem testes dedicados.
    `reap_after_cleanup` preserva exit cooperativo já observado; disconnect não
    alonga o watchdog vigente. Expiração temporal de Cancel/Reap ocorre no
    planner depois da classificação: intenção nova expirada falha fechado,
    retry scheduled pós-reap converge, e conflito contra tombstone não cria
    cleanup sem owner.
    O workflow constrói ambos os helpers antes de executar os seis testes
    `ignored`; o run remoto de CI ainda é pendente.
    Validação local desta fatia: 500 testes Rust de workspace passaram, com 12
    helpers ignored no harness principal; os seis E2E de produção passaram 6/6 em
    execução explícita. Também passaram 14 doctests, 331 testes host/contratos
    TS, typecheck host, `rustfmt`, Clippy `-D warnings`, build release, lint/build
    Protobuf, codegen idêntico em 6 arquivos, 482 módulos produtivos sob o cap de
    250 LOC e grafo de 7 crates/7 arestas. Os dois binários release continuam
    fail-closed com exit code `78`. O gate de boundary legado segue vermelho no
    worktree global por dois imports Anthropic fora desta fatia e por um
    baseline que aguarda ratchet de duas remoções concorrentes.
    A suíte específica de `agentd-supervisor` desta etapa passou 168 testes,
    com 6 helpers físicos ignorados por desenho no harness padrão.
    O loop permanente de biblioteca agora compõe o ator management async real
    com o lifecycle físico em um owner único; Cancel/Fence/Reap compartilham o
    mesmo planner do adapter síncrono, ACK espera write físico sem bloquear o
    watchdog, e EOF/write failure preservam schedule/owner enquanto fecham
    admission. O receipt de fatos foi normalizado entre transportes, e o evento
    async de `ManagementAck` preserva o corpo validado após o commit único.
    Writes já enfileirados agora permanecem owned pelo
    `SupervisorAsyncService`: cancelar `advance()` depois do enqueue não perde
    a continuação do ledger, e a retomada conclui receipt/tracking antes de
    aceitar outro frame ou declarar drain. Backpressure real também comprova
    que o watchdog continua avançando enquanto o write permanece bloqueado.
    `ShutdownSupervisor` agora é uma transação nativa do serviço async:
    `Drain` fecha admission sem alterar schedules por attempt e usa ceiling
    global; `TerminateAfterGrace` agenda owners por mínimo e pode escalar drain,
    nunca ser enfraquecido. O ledger possui um slot bounded por modo; replay
    físico, retry semântico, conflito chave/digest, ACK cancelado/write failure
    e deadline expirado antes do dispatch possuem cobertura determinística. O
    loop continua selecionando management e lifecycle enquanto drena.
    O mesmo owner recebe `LaunchAttemptProcess` pelo pending inbound
    correlacionado e executa o core compartilhado
    classify/reserve/provision/spawn/handoff/watchdog/facts. A emissão preparada
    sobrevive ao cancelamento de `advance()`, e cada continuação só avança após
    receipt do write/ACK correspondente. Falha de write de `LaunchAccepted`
    fecha admission, termina imediatamente o owner vivo e preserva
    reservation/cleanup. Falha ou regressão de clock após spawn ou completion
    também preserva o owner linear e converge para cleanup/hard-restart, sem
    drop silencioso. ACK tardio de Accepted/Spawned depois de reap confirmado
    consome o fato sem recriar cleanup para `OwnershipKey` ausente; failure key
    stale segue a mesma prova. Ausência sem tombstone física correspondente
    continua sendo erro de ownership, nunca no-op genérico.
    A regressão temporal revelada pela suíte agregada também está coberta:
    `ManagementClockAuthority` soma o anchor Unix com precisão sub-ms ao elapsed
    monotônico antes de projetar milissegundos, eliminando o double-floor de até
    1 ms entre peers com fases distintas. Testes determinísticos cobrem carry,
    equivalência entre fases e overflow fail-closed; nenhum gate muda de estado
    por essa correção.
    `prepare`, spawn contido e `complete_after_spawn` agora executam fora do loop
    Tokio em um worker OS dedicado, owned e joinable, com stack de 1 MiB e
    canais de estágio/cleanup com capacidade 1. O serviço preserva pending
    inbound, estado físico, worker, cleanup owner e reservation se
    `advance()` for cancelado. Testes determinísticos provam retomada sem
    duplicar spawn/completion, watchdog de sibling durante spawn bloqueado e
    shutdown sem drain prematuro. `Launching` e `BootstrapPending` impedem reap
    antes do handoff; retries não entram em spin e terminação diferida não é
    repetida imediatamente. O efeito físico de spawn possui um único callsite
    de produção no supervisor, ratchetado pelo gate de arquitetura.
    O binário de produção do runner já compõe o accept/pump físico, completa
    `AgentHello ↔ HostHello`, autentica o data endpoint e conduz a hidratação
    chunked até o owner pós-Active. O Host possui o sender e o adapter
    `test|shadow`; core e wrapper N-API já materializam e retêm os owners opacos
    no mesmo HANDLE/FD, mas `PrepareAttempt` continua fail-closed em produção
    enquanto o adapter não os ligar ao framing/driver TS.
    Pendente:
    integrar o owner pós-Active com pulse/effects e ligar o serviço supervisor ao seu `main`
    process-real; implementar heartbeat, drain
    cooperativo, cancelamento host-owned, `UpdateAttemptAuthority`,
    `QuerySupervisorState` e outbox/fatos duráveis
    `AttemptProcessExited`/`AttemptProcessReaped` e substituir o `main` scaffold
    do supervisor pela composição real; estender o E2E Host TS↔binários de Hello
    para Prepare/Activate/Cancel/Fence/Reap, testes de expiry nas
    fronteiras do spawn/Ready, matriz Windows packaged/nested/breakaway,
    backend de spawn Unix e unlink Unix descriptor-relative. O item permanece
    aberto.
- [ ] `G1-HS-04` — `Prepared` e `ActiveAuthority` só são instalados após receipt
  ligado ao mesmo inbound; EOF/error/drop revogam e nenhuma API pública permite
  check→dispatch com TOCTOU.
  - Spec: `IPC-012..014`, `D-RUST-017..018`, `D-RUST-022`
  - Evidência parcial (2026-07-26): Host e runner mintam `Prepared` somente
    depois do commit físico ligado ao inbound. O Host instala autoridade ativa
    após ACK correlacionado ao `ActivateAttempt`; o runner só a instala depois
    do receipt do ACK e de nova amostragem do deadline. EOF, write failure,
    cancelamento, future nunca pollada e expiry envenenam/revogam os owners. O
    coordinator Host também revoga após `Active`; no runner, o lifetime guard
    pós-ACK cobre idle além do read timeout, EOF, pre-cancel, hard deadline,
    frame parcial, drop antes/depois do primeiro poll, replay exato, conflito e
    expiry semântica pós-I/O. Cancel/Fence seguem a mesma fronteira: o gate é
    revogado antes do await do ACK, enquanto lifecycle/cache/outcome só são
    instalados depois do receipt ligado ao inbound e da verificação pós-write.
    Write failure, expiry, clock regression, conflito ou drop fecham sem
    restaurar authority. O dispatch gate produtivo de provider/tools e o
    cancelamento das operações in-flight ainda não existem; item aberto.
- [ ] `G1-HS-05` — Replay é limitado por entries e bytes físicos, outcome e
  replay físico compartilham buffer sem permitir transplante entre canais, e
  hidratação perdida/expirada é abortada/reaped sem pin de processo ou heap.
  - Spec: `IPC-010..014`, `D-RUST-020..021`
  - Evidência parcial (2026-07-26): replay possui limites selados por entries e
    bytes, tombstones bounded e binding por canal; replay físico exato de
    `Prepared` e `ActivateAck` reutiliza os mesmos bytes sem avançar sequence.
    Cancel/Fence também cobrem replay físico com ACK byte a byte idêntico e
    retry semântico com novo header somente para mesma idempotency key e digest;
    conflito ou troca de tipo fecham o canal.
    No management, o ledger bounded do launch retém no máximo uma intenção
    Cancel/Fence/Reap de cada tipo e, enquanto a tombstone estiver retida,
    proíbe a mesma chave entre tipos ou attempts; replay físico não volta ao
    handler e retry semântico idêntico recebe ACK novo sem repetir o schedule,
    inclusive após reap.
    `LaunchAttemptProcess` também cobre replay físico byte-identical e retry
    semântico da mesma chave/digest sem novo provisionamento ou spawn. O
    `SupervisorDriverStep` marca a aceitação reutilizada nos estados
    Reserved/Running/Cancelling/Exited/Reaping e depois do reap enquanto o
    accepted snapshot bounded estiver retido. O snapshot é redigido e não retém
    nonce, token, handles ou receipt. Digest divergente conflita; o ACK do replay
    não cria sucessores Spawned/Containment, e uma tombstone sem owner vivo não
    agenda cleanup.
    O cleanup pump preserva ownership sob cancelamento e deadline em vez de
    abandonar processo/heap. O runner cancela/revoga hydration interrompida,
    expirada ou nunca concluída sem publicar `Prepared`. O término do lifetime
    ativo agora devolve `ActiveRunnerCleanup<R>` com os recursos lineares ainda
    retidos. O bridge management→schedule/reaper físico já existe no core do
    supervisor. O primeiro E2E com o `agent-runner.exe` de produção real passou
    `spawn contido → handoff/Ready → Reserved → EOF management → terminate Job
    → reap`, liberando ownership, reservation e cleanup a zero; a suíte física
    explícita passou 7/7. O accept/pump data runner-side já está ligado e retém
    o stream autenticado no owner pós-Active; o sender/pump Host `test|shadow`
    já é bounded e ligado ao gate de `Prepared`. Ainda faltam o bridge físico
    de produção, correlação do owner pós-Active com exit observado e fatos
    duráveis do Host; item aberto.
- [x] `G1-STOR-01` — Workspace contém crate folha `agent-session-store` sem
  dependência de engine/runner/supervisor, com identidade UUID canônica, layout
  explícito e limites simultâneos de records/payload.
  - Spec: `D-RUST-029`, `DUR-001`, `DUR-025`, `DUR-030`
  - Evidência (2026-07-28): `native/agent-runtime/crates/agent-session-store`;
    10 testes focados; workspace all-targets 512 passed/12 ignored; 14 doctests;
    clippy `-D warnings`, rustfmt e release aprovados; LOC 503 módulos/250 cap;
    grafo 8 crates/7 edges.
- [x] `G1-STOR-02` — Writer Rust possui lease físico fenced por
  `storageGeneration + leaseEpoch`, recovery de tail/hash, commit
  content-addressed e receipt idempotente.
  - Spec: `DUR-002`, `DUR-015..018`, `DUR-027..030`, `ADR-001`
  - Evidência (2026-07-28): manifesto imutável `rust_fs_v1`; authority log
    append-only/hash-chained com epochs contíguos e rejeição de stale/gap;
    lease físico validado antes de cada commit; journal e receipt ligados a
    session/generation/epoch/writer/operation/sequence/hashes/durability;
    replay idempotente, payload content-addressed, recovery de tails
    incompletas, revalidação e quotas. 10 testes focados e todos os gates Rust
    aprovados. O IDL/bridge e a transferência do writer pertencem aos próximos
    itens `G1-STOR-03/04`.
- [x] `G1-STOR-03` — `session_store.proto` e bridge nativo autenticado cobrem
  open/commit/read/query/transfer/archive sem entregar path mutável ao
  TypeScript.
  - Spec: `D-RUST-010`, `D-RUST-027`, `D-RUST-029`, `DUR-027..031`
  - Evidência (atualizada em 2026-07-29): `session_store.proto` gera bindings
    TS/Prost path-free para open/commit/read/query/projection/transfer/archive/
    close. A leitura exige writer/authority/operation/kind/hash/tamanho exatos,
    revalida lease físico, faz leitura bounded e reverifica tamanho/SHA-256;
    hash isolado nunca é capability. O crate `agent-session-bridge` possui
    owner opaco ligado ao processo, registry bootstrap-only de `root_id`, frame bounded com
    instance/sequence/deadline/hash pré-decode, writer handles e receipts
    fenced. Open/commit/query/archive/close executam no store; projection e
    transfer passam exclusivamente por extension port Rust compilado e o
    bridge valida o receipt. O port default rejeita fail-closed; a transferência
    física real continua isolada em `G1-STOR-04`. Evidência desta atualização:
    6 testes do bridge, 17 do store e 340 testes Host/contracts; workspace Rust
    532 passed/14 ignored, 14 doctests e 5 E2E físicos explícitos; Clippy
    `-D warnings`, rustfmt, release, `buf lint/build` aprovados; LOC 544
    módulos/250 cap; grafo 9 crates/9 edges. A repetição adicional do codegen
    ficou sem evidência nova porque o plugin remoto do Buf estava indisponível;
    os bindings gerados anteriormente nesta fatia compilam e passam as suítes.
- [x] `G1-STOR-04` — Transferência de um bundle real
  `typescript_fs_v1 → rust_fs_v1` passa drain, verificação, crash injection e
  rejeita dual-writer/stale epoch.
  - Spec: `DUR-027..031`, `CUT-064`, `ADR-001`
  - Evidência (2026-07-28): `agent-session-store` implementa lock físico
    serializado, guard `create_new` compatível com o lease TypeScript,
    inventário content-addressed com limites simultâneos, staging no mesmo root,
    snapshot integral em `legacy/typescript_fs_v1`, checkpoint authoritative,
    swap por rename+directory sync e activation receipt idempotente. O bridge
    path-free executa a operação pelo
    `FilesystemSessionStoreExtensionPort`; nenhum path cruza o IDL. Cinco testes
    físicos cobrem bundle real, replay, writer ativo, stale epoch, mutação,
    idempotency divergente e crash em cada uma das quatro barreiras; um teste
    adicional percorre o wire autenticado real. Store/bridge: 21 testes focados;
    workspace all-targets 523 passed/12 ignored, 14 doctests, clippy
    `-D warnings`, rustfmt e release aprovados; LOC 522 módulos/250 cap e grafo
    9 crates/9 edges. O gate global `check:agent-boundary` permanece vermelho
    por drift concorrente da baseline TypeScript (56 referências removidas/87
    imports existentes fora da baseline, nenhum nos arquivos desta etapa);
    deliberadamente não foi mascarado por regeneração.
- [x] `G1-PKG-01` — Supervisor e runner release são empacotados, possuem
  manifest/build ID/hash e verificação de integridade.
  - Spec: `SCOPE-011`, `IPC-033`
  - Evidência (2026-07-28): o build Electron produz somente o target corrente
    em `extraResources/native-agent-runtime/<target>` e embute no ASAR um
    anchor separado. Manifest determinístico liga os dois executáveis a
    versão, commit fonte, target, contrato, tamanho e SHA-256; `buildId` é
    derivado desses campos. O Host faz parse estrito, valida o anchor,
    containment, arquivo regular sem link, identidade durante leitura, tamanho
    e hash em streaming antes de expor paths verificados. Build real
    `--release --locked` e verificação cruzada Host passaram no Windows x64;
    reconstrução preservou manifest/anchor; 5 testes de tamper/target passaram,
    suíte contracts+Host 340 testes e typecheck aprovados. CI repete package e
    verificação Host em Linux, macOS e Windows; orçamento LOC permanece em 527
    módulos de produção sob cap 250. Assinatura, AV, launch instalado e path
    somente leitura continuam deliberadamente abertos em `G1-PKG-02`.
  - Atualização 2026-07-29 (spec 1.5.0): o manifesto passa a exigir também
    `agent-host-bridge.node`; build ID e anchor cobrem os três artefatos. Build
    release `--locked`, verificação Host, carga do addon a partir do pacote
    verificado e smoke Node/Electron passaram no Windows x64.
- [ ] `G1-PKG-02` — Smoke da build instalada passa em cada plataforma
  suportada, inclusive antivírus/assinatura e path somente leitura.
  - Spec: `GATE-PKG-01`, `RUST-R037`
  - Evidência parcial (2026-07-28): `agent-platform` fornece package probe
    inerte, token-gated e sem authority; runner/supervisor continuam retornando
    `78` no modo normal. O smoke extrai o anchor do `app.asar`, exige as fuses
    de integridade/ASAR-only, revalida inventário e hashes, copia o pacote para
    ACL read/execute-only, prova negação de escrita e mata fisicamente os dois
    processos após readiness com PID conferido. Uma build `dir` Windows x64
    real passou esse fluxo; `packageManager=pnpm@10.22.0` eliminou o OOM de
    4 GiB causado pela detecção incorreta como npm. O gate `required` rejeitou
    corretamente CodeStudio, runner e supervisor sem Authenticode. Microsoft
    Defender não concluiu o custom scan no ambiente sem elevação. CI foi
    preparado para package/Host/read-only/launch/kill em Linux, macOS e Windows,
    mas a execução remota ainda não constitui evidência. Regressão local:
    workspace Rust com 526 testes aprovados/12 ignorados por desenho, Host e
    contratos com 340 testes aprovados, clippy estrito, typechecks, grafo de 9
    crates/9 edges e orçamento LOC com 528 módulos de produção sob cap 250.
    O smoke read-only atual também carrega o addon em processo filho bounded,
    valida ABI/target/contrato, prova rejeição fail-closed e só então encerra o
    filho para liberar a DLL antes da limpeza. O mesmo addon passou no Electron
    42.5 em modo Node. A carga instalada local do terceiro artefato está
    comprovada, mas não altera os bloqueios de assinatura/AV/matriz abaixo.
    Permanecem bloqueantes: certificado e AV válidos no Windows, Developer
    ID/notarização no macOS, assinatura destacada no Linux e smoke instalado
    aprovado em todos os targets declarados.
- [ ] `G1-PERF-01` — Spawn até `AttemptPrepared` tem p95 ≤ 250 ms na matriz
  definida.
  - Spec: `GATE-PERF-01`
  - Evidência parcial (2026-07-29): feature `performance-harness` não
    empacotada inicia o binário release real em target directory separado,
    exige flag/token efêmero e percorre o driver
    `AgentHello → HostHello → PrepareAttempt → AttemptPrepared`. O parent mede
    antes do spawn até decodificar o segundo frame, exige exit limpo e timeout
    de 5 s; não envia `ActivateAttempt` nem cria authority de efeito. Windows
    x64 local, após 10 warm-ups e 100 processos medidos: p50 16.830 µs, p95
    41.095 µs, p99 53.908 µs e máximo 103.644 µs, contra threshold 250.000 µs.
    Relatório JSON foi produzido e a CI executará/guardará a mesma evidência em
    Linux, macOS e Windows. Regressão all-features: 527 testes Rust aprovados/12
    ignorados por desenho, clippy estrito, rustfmt, grafo 9 crates/9 edges e 536
    módulos de produção sob cap 250. A build default foi reconstruída sem a
    feature e devolveu `78` tanto sem argumento quanto diante do argumento do
    harness. O checkbox permanece aberto até a matriz remota comprovar as três
    plataformas.
- [ ] `G1-GATE` — Gate G1 aprovado.
  - Spec: `MIG-012`
  - Evidência:

## 5. G2 — supervisor, lifecycle e isolamento

- [ ] `G2-PROC-01` — Cada `AgentRunAttempt` recebe um processo single-tenant e
  nenhum processo é reutilizado.
  - Spec: `RUN-001..011`
  - Evidência:
- [ ] `G2-PROC-02` — Supervisor não retém transcript, provider state, artifact
  body ou catálogo privado de run.
  - Spec: `D-RUST-003`
  - Evidência:
- [ ] `G2-ADM-01` — Admission reserva memória, processos e budget do run-tree
  antes do spawn e devolve reserva após reap.
  - Spec: `RUN-021..023`, `RUST-R002`, `RUST-R031`
  - Evidência parcial (2026-07-26): o E2E físico do driver comprova memória e
    processos reservados antes/durante bootstrap e timeout, inclusive enquanto
    cleanup permanece retido; ambos voltam a zero somente depois da prova de
    reap pelo `SupervisorCleanupPump::advance`. O pump só toma o driver depois
    do fechamento de admissão e da cobertura integral por cleanup. O ledger
    target-specific também mantém owner e reservation depois de ACK perdido ou
    ceiling expirado e só os libera após reap atribuído; cancelar uma attempt
    não altera sua sibling. O ledger agregado de child run-tree ainda é
    pendente.
- [ ] `G2-ISO-01` — Windows Job Object inclui descendentes, caps e
  `KILL_ON_JOB_CLOSE`; nested/breakaway tests passam.
  - Spec: `RUN-024..028`, `RUST-R003`
  - Evidência parcial (2026-07-26): o caminho físico completo lança o helper
    suspenso no Job, aplica limites, termina a árvore e comprova reap tanto no
    sucesso quanto no timeout. A matriz nested/breakaway permanece pendente.
- [ ] `G2-ISO-02` — Linux cgroup v2 e macOS process-group/rlimit/watchdog
  declaram e provam seu nível real de contenção.
  - Spec: `RUN-029..031`, `RUST-R004`
  - Evidência:
- [ ] `G2-LIFE-01` — State machine cobre spawn, handshake, hydrate, run,
  checkpoint, cancel, terminal, exit e reap.
  - Spec: `RUN-006..023`
  - Evidência parcial (2026-07-26): as máquinas atuais cobrem reservation,
    spawn contido, bootstrap/Ready, management EOF, cleanup e reap, além da
    transação `AgentHello → Prepare → Prepared → Activate → Ack → Active`. O
    coordinator Host propaga abort/failure pós-Active aos owners de control e
    management. No runner, Cancel/Fence aceitos percorrem
    `Active → Cancelling` somente depois do ACK físico; o lifetime os converte
    em `RemoteCancelled`/`Fenced`, fecha em `Exiting`, revoga authority e
    preserva ownership para cleanup. No supervisor, Cancel/Fence/Reap percorrem
    ledger bounded → schedule → ACK → termination/cleanup/reap, com precedência
    monotônica e ownership target-specific. O `SupervisorAsyncService` já
    serializa o ator async real e os ticks do mesmo core, preserva o owner sob
    cancelamento do future e devolve o core fechado ao completar drain. O mesmo
    core de Launch é usado pelos adapters síncrono e assíncrono e cobre
    reservation, provisionamento, spawn contido, handoff, watchdog, fatos
    correlacionados, replay e cleanup fail-closed. Continuam pendentes Run,
    checkpoint, terminal durável, integração process-real do runner, outbox de
    Exited/Reaped, estado `Reaped` end-to-end, recovery, pulse e drain
    cooperativo; item aberto.
- [ ] `G2-LIFE-02` — Liveness e progress são distintos; hard deadline não pode
  ser renovado por heartbeat.
  - Spec: `RUN-005..008`, `IPC-047..048`
  - Evidência parcial (2026-07-26): hard deadlines são imutáveis no launch,
    bootstrap, activation e cleanup pump; Activate/ACK verificam o limite antes
    e depois do write. O framing async também verifica antes/depois de read,
    write e replay, e cancelamento de futures/`advance` não recria sua janela.
    No control pós-Active, idle não consome `read_timeout`; depois do primeiro
    byte, progresso parcial é bounded por esse timeout e pelo hard deadline
    imutável. ACKs de Cancel/Fence usam o mínimo entre write timeout e hard
    deadline; Cancel inclui também seu grace deadline selado. No supervisor,
    todo launch instala watchdog inicial em `min(hard deadline, authority
    lease)`, e disconnect só pode encurtá-lo. O tick owner-clock já aplica esse
    limite antes e depois de termination, cleanup de provisionamento e reap.
    `SupervisorOnlineLifecycle` acorda pelo próximo deadline sem tráfego
    management; igualdade expira, regressão/tempo inválido falham fechado e
    shutdown fecha admissão e agenda todos os owners. O gate pós-reap roda antes
    da liberação da reservation; falha após sucesso físico deixa a entry
    quarantined e contabilizada. O lifecycle agora está composto com o
    `AsyncEstablishedManagementActor` real em owner único e cancel-safe:
    watchdog vence receive pendente, frame/timer são serializados, ACK de
    termination ocorre após schedule, retry semântico não repete efeito, write
    failure fecha admission sem apagar o schedule e shutdown idle retorna o
    core retido. O owner também retém writes pendentes entre cancelamentos de
    `advance()`, retoma o tracking antes do próximo ACK e mantém o watchdog
    ativo sob backpressure. A suíte de composição cobre também Launch fresh,
    replay físico, retry semântico, falha de provisionamento/write, cancelamento
    de write e regressão de clock pós-spawn.
    Em 2026-07-27, `ShutdownSupervisor` passou a compartilhar o mesmo owner:
    `Drain` preserva deadlines das attempts sob ceiling global,
    `TerminateAfterGrace` agenda todos os owners por mínimo, escalation é
    monotônica e o ACK só é emitido depois da mutação. Ledger bounded, replay
    físico, retry semântico, conflito, cancelamento/write failure e expiry
    pré-dispatch estão cobertos no serviço async.
    O bootstrap físico já roda no worker de launch owned e cancel-safe, portanto
    watchdog e shutdown não dependem de seu retorno. Ainda faltam
    `UpdateAttemptAuthority`, Heartbeat, `RunnerPulse`, `QuerySupervisorState`
    e progress deadlines de operações; item aberto.
- [ ] `G2-LIFE-03` — Fence perdido fecha admissão, cancela operações host-owned
  e mata a árvore após grace.
  - Spec: `RUN-009..012`, `IPC-011..012`
  - Evidência parcial (2026-07-26): `FenceAttempt` valida identity exata, epoch
    substituto estritamente maior, timestamp, reason e idempotência. Uma fence
    válida revoga o gate antes do ACK, instala `Cancelling` somente após receipt
    físico e produz cleanup tipado `Fenced`. No supervisor,
    `FenceAttemptProcess` seleciona somente a ownership exata, entra no ledger
    antes do schedule, usa grace
    `min(hard deadline, observed + sealed cancel_grace_ms)` e não pode alongar
    Cancel anterior; Reap posterior torna termination imediatamente due.
    O timer já participa do serviço async de biblioteca sem depender de novo
    frame; ainda faltam ligá-lo ao binário process-real, cancelamento das
    operações host-owned, outbox/fatos duráveis e E2E Host TS que prove
    kill/reap; item aberto.
- [ ] `G2-LIFE-04` — Cancel ACK p95 ≤ 250 ms e árvore não cooperativa some em
  até 2 s depois da grace.
  - Spec: `GATE-LIFE-02/03`
  - Evidência parcial (2026-07-26): o ACK de `CancelAttempt` usa
    `min(grace deadline, hard deadline, write timeout)`, verifica o clock antes
    e depois do write e falha fechado no limite, em regressão ou abandono.
    `grace_deadline` também é limitado pelo budget selado. O supervisor valida
    o mesmo teto físico antes de ACKar o schedule; seu watchdog inicial e
    deadlines monotônicos impedem Cancel/Fence/disconnect de ampliar a vida da
    attempt. O loop async já mantém o timer ativo enquanto o ACK está em write.
    Ainda faltam medição p95, drain cooperativo, routing no processo real e
    prova E2E de desaparecimento da árvore não cooperativa em até 2 s; item
    aberto.
- [ ] `G2-LIFE-05` — 1.000 ciclos/24 h deixam zero PID, Job, pipe, handle e
  scratch dir órfão.
  - Spec: `GATE-LIFE-01`
  - Evidência:
- [ ] `G2-MEM-01` — Memory bomb mata apenas o attempt alvo; attempt paralelo
  conclui normalmente.
  - Spec: `RUN-010`, `RUN-023..028`, `GATE-ISO-01`, `RUST-R008`
  - Evidência:
- [ ] `G2-MEM-02` — Supervisor ocioso fica ≤ 40 MiB depois do warm-up.
  - Spec: `GATE-MEM-01`
  - Evidência:
- [ ] `G2-MEM-03` — Depois de 500 attempts, supervisor retorna a
  `baseline + max(10 MiB, 10%)`.
  - Spec: `GATE-MEM-04`
  - Evidência:
- [ ] `G2-PRE-01` — Cada runner prewarmed consome reserva global antes do spawn
  e só recebe attempt que caiba integralmente no envelope.
  - Spec: `RUN-036..038`, `RUST-R041`
  - Evidência:
- [ ] `G2-SPEC-01` — Contract/chaos suites cobrem todos os requisitos
  `RUN-001..038`, sem waiver não registrada.
  - Spec: `RUN-001..038`
  - Evidência:
- [ ] `G2-GATE` — Gate G2 aprovado.
  - Spec: `MIG-013`
  - Evidência:

## 6. G3 — engine Rust e Provider Gateway TS

- [ ] `G3-ENG-01` — Engine depende apenas dos ports tipados de provider,
  capability, artifact, journal, clock e child run.
  - Spec: `ENG-001..009`
  - Evidência:
- [ ] `G3-ENG-02` — Loop lógico completo é determinístico sob fixtures e não
  depende de classes/closures TypeScript.
  - Spec: `ENG-001`, `ENG-004..011`, `ENG-044..045`
  - Evidência:
- [ ] `G3-CTX-01` — Hot transcript tem limite por bytes/tokens; capítulos
  antigos e payloads grandes são refs.
  - Spec: `ENG-012`, `ENG-015..020`, `DUR-007..009`
  - Evidência:
- [ ] `G3-CTX-02` — Compactação preserva tool/result pairing, identity,
  interactions, budgets e side-effect ledger.
  - Spec: `ENG-009`, `ENG-020..025`
  - Evidência:
- [ ] `G3-PROV-01` — OAuth, secrets, adapters e retry físico permanecem no
  Provider Gateway TS.
  - Spec: `IPC-017..019`, `CAP-028..032`
  - Evidência:
- [ ] `G3-PROV-02` — `ProviderStart`, stream, cancel, usage, fallback lógico e
  terminal tipado passam na matriz de adapters.
  - Spec: `IPC-017..019`, `CAP-028..032`
  - Evidência:
- [ ] `G3-PROV-03` — Perda de fence cancela todas as provider operations do
  attempt; registry do host é bounded e evicted.
  - Spec: `IPC-019`, `CAP-028..031`, `RUST-R009`
  - Evidência:
- [ ] `G3-PROV-04` — Fallback lógico checkpointa, encerra apenas a attempt e
  cria attempt `provider_fallback` com epoch maior; retry físico não faz isso.
  - Spec: `RUN-003`, `ENG-014`, `IPC-042`, `IPC-045`
  - Evidência:
- [ ] `G3-PROV-05` — Provider Gateway, OAuth, plugin providers, aliases,
  pricing, reasoning, vision e usage funcionam sem importar provider do
  `code-agent`.
  - Spec: `CUT-023`, `CUT-034`, `RUST-R049`
  - Evidência:
- [ ] `G3-ROUTE-01` — Geração `legacy_ts | rust_v1`, razão, cohort, engine e
  catalog hash são persistidos antes do launch; attempt ativa não muda.
  - Spec: `CUT-005..006`, `CUT-012`, `CUT-020`, `CUT-059..060`
  - Evidência:
- [ ] `G3-ROUTE-02` — Attempt persiste runtime/protocol version, binary digest
  e catalog digest; o canário é sticky por sessão/superfície.
  - Spec: `CUT-059..060`
  - Evidência:
- [ ] `G3-PROJ-01` — LegacyAdapter e RustHostAdapter alimentam o mesmo Rust
  session store e projector sem consulta ao runner para completar estado.
  - Spec: `CUT-008`, `CUT-018`, `CUT-032`, `CUT-062`, `CUT-064`
  - Evidência:
- [ ] `G3-IPC-01` — Control permanece responsivo com data bloqueado e toda fila
  respeita frame/byte credits.
  - Spec: `IPC-006..010`, `IPC-027..029`, `GATE-IPC-01`
  - Evidência:
- [ ] `G3-EVT-01` — Classes A–C e tipos D declarados duráveis têm paridade
  semântica 100%; terminal nunca ultrapassa delta ou artifact requerido.
  - Spec: `DUR-012..023`, `GATE-EVT-01`
  - Evidência:
- [ ] `G3-MEM-01` — Runner representativo tem incremento privado ≤ 64 MiB.
  - Spec: `GATE-MEM-02`
  - Evidência:
- [ ] `G3-PERF-01` — TTFT p95 regride no máximo 5% contra baseline comparável.
  - Spec: `GATE-PERF-02`
  - Evidência:
- [ ] `G3-SPEC-01` — State-machine/property suites cobrem todos os requisitos
  `ENG-001..048`, sem waiver não registrada.
  - Spec: `ENG-001..048`
  - Evidência:
- [ ] `G3-GATE` — Gate G3 aprovado.
  - Spec: `MIG-014`
  - Evidência:

## 7. G4 — capabilities, tools e execução aninhada

- [ ] `G4-CAT-01` — Catálogo é serializável, versionado e tem canonical
  bytes/hash idênticos em TS e Rust.
  - Spec: `CAP-001..004`, `CAP-045..047`, `RUST-R016`
  - Evidência:
- [ ] `G4-CAP-01` — Todas as invocations seguem prepare, approval, accepted,
  started e terminal por `operation_id`.
  - Spec: `CAP-005..010`, `IPC-020..021`
  - Evidência:
- [ ] `G4-CAP-02` — Grant vincula input, capability, environment, workspace,
  fence, constraints e expiry; Rust revalida antes do efeito.
  - Spec: `CAP-008..010`, `RUST-R018`
  - Evidência:
- [ ] `G4-CAP-03` — Timeout/EOF pós-started produz probe ou
  `outcome_unknown`, nunca retry automático.
  - Spec: `CAP-005..007`, `IPC-021`, `RUST-R017`
  - Evidência:
- [ ] `G4-READ-01` — Filesystem read, glob, grep, Git read e HTTP read passam
  functional, traversal, quota e cancellation suites.
  - Spec: `CAP-011..013`, `CAP-024..027`
  - Evidência:
- [ ] `G4-MUT-01` — Write/edit/patch e Git mutation passam workspace
  binding/fence, idempotência e adversarial suites.
  - Spec: `CAP-014..017`
  - Evidência:
- [ ] `G4-PROC-01` — Shell/PTY/processos têm timeout, output bounded e
  process-tree cleanup em todos os terminais.
  - Spec: `CAP-018..023`, `RUST-R026`
  - Evidência:
- [ ] `G4-HOST-01` — MCP/plugins/LSP/browser/docs/memory usam ToolHost TS com
  o mesmo lifecycle, policy e output contract.
  - Spec: `CAP-033..036`
  - Evidência:
- [ ] `G4-HOST-02` — Company, DocsAgent, plugins e integrações usam
  descriptors/handlers neutros; nenhum contrato público depende de
  `CoderTool`, `ToolContext` ou `ToolRegistry`.
  - Spec: `CUT-017`, `CUT-024`, `CUT-026`, `CUT-036`
  - Evidência:
- [ ] `G4-HOST-03` — MCP externo mutante não é reconectado/repetido depois de
  `accepted/started`; ACK inconclusivo converge para probe ou
  `outcome_unknown`.
  - Spec: `CUT-007`, `CUT-036`, `RUST-R017`
  - Evidência:
- [ ] `G4-CODE-01` — `code_exec` roda em processo descartável no resource group,
  com env limpo e somente proxy de capabilities.
  - Spec: `CAP-037..041`, `RUST-R027..028`
  - Evidência:
- [ ] `G4-REMOTE-01` — Environment remoto nunca cai para execução local e passa
  pelo mesmo policy, lifecycle, quotas, artifact pipeline e reconciliação.
  - Spec: `CAP-048..052`, `RUST-R043`
  - Evidência:
- [ ] `G4-OUT-01` — Output grande aparece como artifact+preview e não é
  triplicado em heap, IPC e transcript.
  - Spec: `CAP-042..044`, `DUR-003..006`
  - Evidência:
- [ ] `G4-SEC-01` — Scanner encontra zero credencial reutilizável em argv, env,
  logs, frames, artifacts e dumps; nonce/token efêmero existe somente nos
  frames de bootstrap autorizados e é scrubbed em todos os terminais.
  - Spec: `SEC-001..006`, `GATE-SEC-01`
  - Evidência:
- [ ] `G4-SEC-02` — Código hostil roda com token restrito/AppContainer ou
  integridade menor; teste prova que não abre o supervisor com
  `PROCESS_DUP_HANDLE` nem duplica o último handle do Job.
  - Spec: `RUST-R060`
  - Evidência:
- [ ] `G4-POL-01` — Chaos registra zero efeito não autorizado e zero duplicação
  de mutation.
  - Spec: `GATE-POL-01`
  - Evidência:
- [ ] `G4-PERF-01` — Overhead p95 do dispatch nativo é ≤ 5 ms.
  - Spec: `GATE-PERF-03`
  - Evidência:
- [ ] `G4-SPEC-01` — Suites por execution class cobrem todos os requisitos
  `CAP-001..052`, sem waiver não registrada.
  - Spec: `CAP-001..052`
  - Evidência:
- [ ] `G4-GATE` — Gate G4 aprovado.
  - Spec: `MIG-015`
  - Evidência:

## 8. G5 — durability, waiting e run-tree

- [ ] `G5-ART-01` — Scratch, spool e artifact store são camadas separadas com
  quotas por artifact/attempt/session/global.
  - Spec: `DUR-003..006`, `DUR-025..026`
  - Evidência:
- [ ] `G5-ART-02` — Promotion valida containment, tamanho, hash e manifest antes
  do ACK durable.
  - Spec: `DUR-003..005`, `SEC-005..006`
  - Evidência:
- [ ] `G5-ART-03` — GC mark/sweep preserva toda ref durable e remove órfãos
  somente depois da grace.
  - Spec: `DUR-006`, `DUR-026`, `RUST-R023`
  - Evidência:
- [ ] `G5-CHK-01` — Checkpoint versionado contém apenas estado bounded e refs;
  escrita/promotion é crash-safe.
  - Spec: `DUR-007..011`
  - Evidência:
- [ ] `G5-CHK-02` — Crash em cada fronteira mantém o último checkpoint
  confirmado legível em 100% dos casos.
  - Spec: `GATE-REC-01`
  - Evidência:
- [ ] `G5-WAIT-01` — Waiting/interaction checkpointa e encerra o process; a
  resposta cria attempt `resume` com epoch maior.
  - Spec: `ENG-029..032`, `ENG-048`, `RUN-013..015`, `IPC-041..045`
  - Evidência:
- [ ] `G5-CHILD-01` — Todo subagente visível/durável é child `AgentRun` com
  attempt e processo próprios.
  - Spec: `ENG-033..038`, `RUN-016..020`
  - Evidência:
- [ ] `G5-CHILD-02` — Host aplica maxAgents/maxDepth, admission e budget
  delegado atomicamente antes do child spawn.
  - Spec: `ENG-034..038`, `RUN-017..018`, `RUST-R031`
  - Evidência:
- [ ] `G5-CHILD-03` — Pai recebe digest/result/transcript refs bounded, nunca o
  transcript integral do filho no heap.
  - Spec: `ENG-035`, `RUN-019`, `RUST-R029`
  - Evidência:
- [ ] `G5-CHILD-04` — Terminal de child atualiza somente o child; root command
  depende da completion policy do root e dos children/verifier obrigatórios.
  - Spec: `IPC-030`, `IPC-046`, `DUR-012`
  - Evidência:
- [ ] `G5-BG-01` — Foreground/background alteram wait mode, não deadline,
  authority ou obrigação de reaping.
  - Spec: `ENG-039..041`, `RUN-014`, `RUST-R030`
  - Evidência:
- [ ] `G5-SURF-01` — DocsAgent usa role/catalog Rust e não instancia
  `CoderRunner` ou `ToolRegistry`.
  - Spec: `CUT-039`, A10 de `08`
  - Evidência:
- [ ] `G5-SURF-02` — `execute_tasks`, workflows, ChatPipeline e verifier
  agendam child AgentRuns; nenhum estágio chama `runSubagent`.
  - Spec: `CUT-038..039`, A09/A11 de `08`
  - Evidência:
- [ ] `G5-SURF-03` — Plugin assistant usa AgentRun Rust restrito e não mantém
  mini-loop de agente paralelo.
  - Spec: `CUT-061`, A20 de `08`
  - Evidência:
- [ ] `G5-MEM-01` — Root+8 filhos usa menos de 3× o incremento privado do
  cenário root-only.
  - Spec: `GATE-MEM-03`
  - Evidência:
- [ ] `G5-SPEC-01` — Suites de storage/journal/telemetria/security cobrem
  `DUR-001..031`, `OBS-001..008` e `SEC-001..006`.
  - Spec: `DUR-001..031`, `OBS-001..008`, `SEC-001..006`
  - Evidência:
- [ ] `G5-GATE` — Gate G5 aprovado.
  - Spec: `MIG-016`
  - Evidência:

## 9. G6 — shadow, chaos, soak e canário

- [ ] `G6-SHADOW-01` — Contract replay compara decisões/eventos com fixtures
  redigidas e executors sem efeito.
  - Spec: `MIG-007`, seção 10.1 de `06`
  - Evidência:
- [ ] `G6-SHADOW-02` — Shadow read-only/decision não publica resposta nem
  executa provider faturável ou mutation em duplicidade.
  - Spec: `MIG-007`, `RUST-R034`
  - Evidência:
- [ ] `G6-CHAOS-01` — Matriz injeta falha em accepted/started/terminal,
  checkpoint, channels, provider, child, OOM, disk e fence.
  - Spec: seção 10.2 de `06`, tabela de failure modes de `07`
  - Evidência:
- [ ] `G6-SOAK-01` — Soak de 6 h tem inclinação robusta < 1 MiB/h no
  supervisor e host após warm-up.
  - Spec: `GATE-MEM-05`
  - Evidência:
- [ ] `G6-SOAK-02` — Attempt representativa permanece ativa por 6 h com
  inclinação privada < 1 MiB/h depois de estabilizar a hot window, sem
  collection/queue ilimitada.
  - Spec: `GATE-MEM-06`
  - Evidência:
- [ ] `G6-SOAK-03` — Soak 24 h/1.000 ciclos mantém zero órfão e terminal único.
  - Spec: `GATE-LIFE-01/04`
  - Evidência:
- [ ] `G6-QUAL-01` — Conformance determinística passa 100% e benchmark agentic
  satisfaz o IC de não inferioridade de −2 pontos percentuais.
  - Spec: `GATE-QUAL-01/02`, `RUST-R044`
  - Evidência:
- [ ] `G6-REL-01` — Erro interno atribuível ao Rust fica ≤ 0,1% e dentro de
  +0,05 ponto percentual do legado.
  - Spec: `GATE-REL-01`
  - Evidência:
- [ ] `G6-ROLL-01` — Kill switch impede novas admissões Rust sem depender do
  daemon.
  - Spec: `MIG-018..023`, `RUST-R036`
  - Evidência:
- [ ] `G6-ROLL-02` — Rollback ensaiado não transfere attempt ativo nem duplica
  efeito pós-started.
  - Spec: `MIG-020..022`, `RUST-R035`
  - Evidência:
- [ ] `G6-SPEC-01` — Contract, compatibility, fuzz e E2E suites cobrem todos os
  requisitos `IPC-001..048`, sem waiver não registrada.
  - Spec: `IPC-001..048`
  - Evidência:
- [ ] `G6-SURF-01` — A01–A11 e A20 passaram canário, restart, cancelamento,
  replay e contrato público com evidência individual.
  - Spec: `CUT-013`, `CUT-031..039`, `CUT-046`
  - Evidência:
- [ ] `G6-SURF-02` — A12–A15 passaram canário por árvore inteira, incluindo
  Company master/subordinates, scheduler, App Studio, pause/resume e recovery.
  - Spec: `CUT-011`, `CUT-040`, `CUT-047`, `RUST-R048`
  - Evidência:
- [ ] `G6-SURF-03` — A16–A19 passaram canário de MCP, CLI, remote, admin,
  shutdown e build instalada.
  - Spec: `CUT-041..044`, `CUT-046`
  - Evidência:
- [ ] `G6-C0` — Canário interno C0 concluído por ≥ 48 h, sem stop condition.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-C1` — Canário 1% concluído por ≥ 48 h e ≥ 200 attempts.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-C2` — Canário 5% concluído por ≥ 72 h e ≥ 1.000 attempts.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-C3` — Canário 25% concluído por ≥ 7 dias na matriz representativa.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-C4` — Canário 50% concluído por ≥ 7 dias com suporte e rollback
  exercitados.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-GATES-01` — Todos os gates `MEM`, `ISO`, `LIFE`, `PERF`, `IPC`,
  `EVT`, `QUAL`, `REL`, `POL`, `REC`, `SEC` e `PKG` passam no mesmo build
  candidato.
  - Spec: seção 3 de `06`
  - Evidência:
- [ ] `G6-GATE` — Gate G6 aprovado.
  - Spec: `MIG-017`
  - Evidência:

## 10. G7 — default e retirada do legado

- [ ] `G7-C5` — Rust atende 100% do tráfego elegível por ≥ 14 dias sem fallback
  acionado por regressão.
  - Spec: seção 10.3 de `06`, `CUT-049`
  - Evidência:
- [ ] `G7-COV-01` — A01–A20 possuem owner, contract/E2E, canário e estado
  `rust_default` no manifest.
  - Spec: `CUT-001`, `CUT-013`, seção 8 de `08`
  - Evidência:
- [ ] `G7-FACADE-01` — HTTP, SSE, Company, DocsAgent, plugin assistant, MCP e
  CLI passam por `AgentRuntimeFacade`; nenhum entry point chama runner/pool.
  - Spec: `CUT-003..004`, `CUT-015..016`, `CUT-031..043`, `CUT-061`
  - Evidência:
- [ ] `G7-DEF-01` — Rust é default durable para todo novo `AgentRun`.
  - Spec: `MIG-018`, `CUT-005`, seção 12 de `06`
  - Evidência:
- [ ] `G7-DEF-02` — Criação de novos attempts legados está desabilitada; attempts
  novos permanecem sticky e duravelmente atribuídos ao Rust.
  - Spec: `CUT-005..006`, `CUT-060`, seção 12 de `06`
  - Evidência:
- [ ] `G7-DRAIN-01` — Zero attempt, lease, interaction, checkpoint, PID, worker
  ou operation host-owned legado permanece ativo/órfão.
  - Spec: `CUT-012`, `CUT-048`, `CUT-055`
  - Evidência:
- [ ] `G7-TREE-01` — Company/App Studio não possui árvore mista; master,
  subordinates, verifier e especialistas são Rust.
  - Spec: `CUT-011`, `CUT-040`, `CUT-047`
  - Evidência:
- [ ] `G7-PROV-01` — Cada attempt tem runtime/protocol version, binary digest e
  catalog digest consultáveis no journal/admin.
  - Spec: `CUT-005`, `CUT-059`
  - Evidência:
- [ ] `G7-PROJ-01` — Journal/projector host é autoridade; não há dual-write,
  tabelas `rust_*` paralelas nem transação duplicada no indexer.
  - Spec: `CUT-007..009`, `CUT-062`
  - Evidência:
- [ ] `G7-HIST-01` — Sessões antigas, IDs legados, transcripts, tasks, goals,
  specs, Company e App Studio continuam legíveis na build sem executor legado.
  - Spec: `CUT-010`, `CUT-019`, `CUT-033`, `CUT-045`
  - Evidência:
- [ ] `G7-EXT-01` — Providers, stores, tool SDK, prompts, skills, LSP,
  pipelines, preview/browser e helpers sobreviventes possuem owner fora do
  package legado.
  - Spec: `CUT-022..028`
  - Evidência:
- [ ] `G7-IMPORT-01` — Busca estática por package/path/tipos/símbolos legados
  retorna zero consumidor fora de documentação e fixtures neutras aprovadas.
  - Spec: `CUT-002`, `CUT-029`, `RUST-R045`, `RUST-R049`
  - Evidência:
- [ ] `G7-DEPS-01` — Dependency graph e manifests de Company, DocsAgent,
  plugin-host, provider-engine e provider-runtime não dependem de
  `@mcp/code-agent`.
  - Spec: `CUT-028..029`
  - Evidência:
- [ ] `G7-ORACLE-01` — Fixtures congeladas substituem o runtime legado como
  oracle e não importam, não transpilam nem executam seu código.
  - Spec: `MIG-024`, `CUT-053`, `RUST-R055`
  - Evidência:
- [ ] `G7-ROLL-01` — Drill antes da retirada prova rollback somente de novas
  attempts, sem transferência ativa ou repetição de mutação.
  - Spec: `MIG-018..023`, `CUT-012`, `CUT-050`
  - Evidência:
- [ ] `G7-DEL-01` — `CoderWorkerPool`, singleton, `coder-worker`, watchdog,
  runner wiring, RPC shims e launch path exclusivos foram removidos em PRs
  auditáveis.
  - Spec: `MIG-024`, `CUT-051..052`
  - Evidência:
- [ ] `G7-COMPANY-01` — O hosting Company não contém agente embutido; o worker
  foi removido ou permanece explicitamente apenas como control plane TS.
  - Spec: A12–A15 de `08`, `CUT-040`, `CUT-052`
  - Evidência:
- [ ] `G7-DEL-02` — `CoderRunner`, `runCoder`, `runSubagent`, registries, tools
  substituídas e `packages/code-agent` foram removidos depois de grafo zero.
  - Spec: `MIG-024`, `CUT-028..029`, `CUT-051..053`
  - Evidência:
- [ ] `G7-BUILD-01` — Scripts, aliases TS/Vite/Vitest, prompts, checks,
  lockfile e Electron packaging não apontam ao legado; cobertura equivalente
  permanece.
  - Spec: `CUT-027`, `CUT-044`, `CUT-051`
  - Evidência:
- [ ] `G7-PKG-01` — Scan do ASAR/extraResources/build instalada prova ausência
  de package, worker, bundle, prompt path e launcher legado.
  - Spec: `GATE-PKG-01`, `CUT-054`, `RUST-R054`
  - Evidência:
- [ ] `G7-PROC-01` — Start/cancel/crash/update/quit/restart da build final deixa
  zero worker V8, PID, Job, pipe, handle, child ou scratch legado.
  - Spec: `CUT-055`
  - Evidência:
- [ ] `G7-OPS-01` — Dashboards, alertas, runbook, suporte e docs apontam para o
  runtime Rust.
  - Spec: `OBS-001..008`, `MIG-024`, `CUT-043`
  - Evidência:
- [ ] `G7-KILL-01` — Kill switch final para novas admissões Rust funciona sem
  depender de fallback legado.
  - Spec: seção 12 de `06`, `CUT-014`
  - Evidência:
- [ ] `G7-DATA-01` — `DataDispositionManifest` classifica toda tabela, coluna,
  índice e artifact como produto, audit, projection, bridge, runtime-only ou
  unknown; nenhum unknown permanece.
  - Spec: `CUT-010`, `CUT-056`, `RUST-R050`
  - Evidência:
- [ ] `G7-DATA-02` — Dados de produto e migrations históricas foram
  preservados; nenhum `DROP` destrutivo ocorreu no PR/release de retirada.
  - Spec: `CUT-010`, `CUT-045`, `CUT-051`, `CUT-056`
  - Evidência:
- [ ] `G7-DATA-03` — Qualquer contração executada respeitou 30 dias e uma
  release estável, com leitor N-1, bancos implantados, backup/restore,
  integrity, contagens e histórico validados.
  - Spec: `CUT-057..058`, `RUST-R056`
  - Evidência:
- [ ] `G7-DATA-04` — Todo bridge/runtime-only remanescente foi removido sob
  `G7-DATA-03` ou retido explicitamente com owner, motivo, retention e prazo.
  - Spec: `CUT-056..058`, `CUT-063`
  - Evidência:
- [ ] `G7-ROLL-02` — Drill pós-deleção volta à última build Rust estável ou
  `halt` sem reintroduzir o code-agent e sem incompatibilidade de schema.
  - Spec: `CUT-014`, `CUT-050`, `CUT-057..058`
  - Evidência:
- [ ] `G7-GATE` — Gate G7 e definição global de concluído aprovados.
  - Spec: `MIG-024`, `CUT-063`, seção 13 de `06`
  - Evidência:

## 11. GI — trilho paralelo do indexador (doc 09)

Fases I0–I4 correm em paralelo ao programa principal com duas amarras: I0 DEVE
preceder o canário G6 (é o piloto de packaging da cadeia nativa) e I2..I4 NÃO
DEVEM iniciar antes de o canário do agentd estar em soak, salvo ADR.

- [ ] `GI-00` — Spec 09 aceita; decisões `D-IDX-001..010` registradas em
  `DECISIONS.md`; ownership de index.db, modelos, generations e `doc_*` com
  exatamente um owner.
  - Spec: `SCOPE-IDX-001..005`, `D-IDX-001..010`
  - Evidência:
- [ ] `GI-01` — Workspace `native/index-runtime` criado; toolchain, lockfile,
  fmt/clippy/audit e build release no CI, espelhando G1.
  - Spec: `D-IDX-001`, `SCOPE-006..009`
  - Evidência:
- [ ] `GI-02` — Baseline congelada em build empacotada: nDCG do harness de
  código (3×, dispersão registrada), eval-metrics de docs e golden extracts por
  linguagem suportada.
  - Spec: `SCOPE-IDX-003`, `D-IDX-010`
  - Evidência:
- [ ] `GI-03` — I0: walker/hasher empacotado e assinado atrás de cohort;
  paridade de conjunto de arquivos em três repositórios reais (incluindo o caso
  Assets/68k); CPU de walk fora do main. `IDX-GATE-0` aprovado.
  - Spec: `D-IDX-009`, `IDX-GATE-0`, `SCOPE-010..012`
  - Evidência:
- [ ] `GI-04` — I1: watch nativo com reconcile por content-hash, sem re-scan
  storm; watch budget rebaixado a telemetria. `IDX-GATE-1` aprovado.
  - Spec: `D-IDX-006`, `IDX-GATE-1`
  - Evidência:
- [ ] `GI-05` — I2: extração tree-sitter com golden extracts idênticos;
  `indexd` como escritor único do `index.db` com lock de transição testado sob
  contenção; consumidores (outline/rename/skeleton) inalterados. `IDX-GATE-2`
  aprovado.
  - Spec: `D-IDX-003`, `D-IDX-010`, `IDX-GATE-2`
  - Evidência:
- [ ] `GI-06` — I3: embeddings bge-m3 e cross-encoder via `ort`; ANN servida
  por RPC; nDCG ≥ baseline; drift coseno dentro do limiar; RSS do Electron sem
  termo de ONNX; re-embed completo por generation. `IDX-GATE-3` aprovado.
  - Spec: `D-IDX-004..005`, `D-IDX-008`, `IDX-GATE-3`
  - Evidência:
- [ ] `GI-07` — I4: compute de RAG docs (extração, chunking, PDF, embed) no
  `indexd`; extraction-pool Node removido; captação/política/persistência
  intactas no host; eval-metrics iguais ou melhores. `IDX-GATE-4` aprovado.
  - Spec: `D-IDX-007`, `IDX-GATE-4`
  - Evidência:

## 12. Auditoria final de invariantes

- [ ] `FINAL-01` — Exatamente um executor ativo por `AgentRunAttempt`.
  - Evidência:
- [ ] `FINAL-02` — Todo child `AgentRun` possui attempt/process/fence próprios.
  - Evidência:
- [ ] `FINAL-03` — SQLite não contém runtime de sessão e não é aberto por Rust;
  `agent-session-store` é o writer físico único dos bundles `rust_fs_v1`, e o
  Host TypeScript não abre seus arquivos mutáveis.
  - Evidência:
- [ ] `FINAL-04` — Nenhum secret ou credential é persistido ou entregue em
  claro ao runner.
  - Evidência:
- [ ] `FINAL-05` — Nenhuma fila, transcript quente, output, spool, mapa de
  operação ou pool de tarefas é ilimitado.
  - Evidência:
- [ ] `FINAL-06` — Terminal durable é único, idempotente e posterior ao
  transcript/artifacts necessários.
  - Evidência:
- [ ] `FINAL-07` — Mutação incerta nunca é repetida automaticamente.
  - Evidência:
- [ ] `FINAL-08` — Waiting, cancel, deadline, crash, OOM e shutdown sempre
  convergem para fence e reap.
  - Evidência:
- [ ] `FINAL-09` — Rust, e não o `code-agent` legado, executa todos os caminhos
  de produto suportados.
  - Evidência:
- [ ] `FINAL-10` — Baseline residual do Electron está medida e tratada como
  frente separada.
  - Evidência:
- [ ] `FINAL-11` — A01–A20 usam o runtime Rust por uma fachada neutra; nenhum
  fluxo de produto mantém mini-runner ou árvore de geração mista.
  - Evidência:
- [ ] `FINAL-12` — `packages/code-agent`, seus workers, bundles, launchers,
  imports e package dependencies estão ausentes da build instalada.
  - Evidência:
- [ ] `FINAL-13` — Sessões e dados históricos continuam legíveis; toda
  contração possui disposition, backup/restore e prova sobre DB implantado.
  - Evidência:
- [ ] `FINAL-14` — Rollback operacional usa a última build Rust estável ou
  `halt`, nunca reativa o executor legado.
  - Evidência:

## 13. Registro de evidências

Adicione uma linha por evidência imutável usada acima.

| ID | Tipo | Commit/build | Plataforma | Data | Link/path | Owner |
|---|---|---|---|---|---|---|
|  | teste/benchmark/trace/chaos/ADR |  |  |  |  |  |
