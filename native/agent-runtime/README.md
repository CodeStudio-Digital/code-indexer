# Agent Runtime

Fundação do novo data plane de agentes em Rust. Este workspace não importa nem
executa `packages/code-agent`.

## Fronteiras

```text
agentd-supervisor ──> agent-platform
        │
        └───────────> agent-protocol

agent-runner ───────> agent-engine
        ├───────────> agent-platform
        ├───────────> agent-protocol
        ├───────────> agent-spool
        └───────────> agent-tools

agent-engine ───────> agent-tools

agent-host-bridge ──> agent-platform
        └───────────> agent-protocol

agent-host-bridge-napi ──> agent-host-bridge
        └───────────────> agent-session-bridge

agent-session-bridge ──> agent-protocol
        └──────────────> agent-session-store

agent-session-store  (crate folha; não depende do runner/supervisor)
```

- `agent-engine`: estado lógico e primeiro loop provider determinístico; sem
  transporte, provider concreto, storage ou SO. O runner compõe seus ports após
  `Active`, inicia o Provider Gateway TS pelo Data process-real e consome
  Accepted→texto→usage→terminal. Seu `EventSinkPort` envia records V1 como
  `EngineEventProposal`; o Host só responde `EngineEventCommitted` depois do
  receipt do writer filesystem Rust. O E2E físico com `native.read_file`
  confirma nove commits até o terminal autoritativo do segundo provider turn.
  O capability path revalida authority, atravessa
  `CapabilityPrepare/CapabilityUpdate` e executa `native.read_file` somente com
  grant/binding selados. `started/terminal` passam pelo mesmo journal antes e
  depois do efeito; o resultado bounded mantém pairing e abre outro provider
  turn. O contexto compartilhado por `Arc<[u8]>` evita um clone persistente.
  O resolver/policy Host confere o catálogo hidratado e sela raiz canônica,
  environment, lease/fence, quotas e expiry sem confiar no input do modelo.
  Erro live do executor depois de `started` produz um terminal
  `outcome_unknown`, retorna como resultado de erro e nunca é repetido pelo
  engine. O session store/bridge agora fornece cursor de recovery path-free,
  autenticado e bounded; o Host detecta `started` órfão somente após conferir
  receipt, payload canônico e cadeia completa. Persistência da decisão de
  recovery/probe, outras tools, resume por checkpoint e fallback permanecem
  fail-closed.
- `agent-protocol`: contratos de identidade, compatibilidade e handshake.
- `agent-platform`: budgets e portas de containment; bindings de SO ficam aqui.
- `agent-tools`: descritores e fronteiras das capabilities.
- `agent-spool`: referências e accounting de blobs fora do heap.
- `agent-host-bridge`: owner Host in-process que liga fatos duráveis e abre
  Control/Data somente após peer check no mesmo HANDLE/FD.
- `agent-host-bridge-napi`: fachada Node-API 8 fina que mantém Control/Data no
  Rust e também expõe o core independente do session bridge pelo mesmo addon
  verificado; fornece I/O bounded/cancelável e `close()` explícito.
- `agent-session-bridge`: owner in-process opaco, framing e adapter Protobuf
  path-free para o store; não depende de engine nem do transporte da attempt.
- `agent-session-store`: writer filesystem bounded e single-owner por sessão.
- `agent-runner`: processo single-tenant que compõe engine e adapters.
- `agentd-supervisor`: admission e ownership físico de processos/resource groups.

O supervisor não depende de engine, tools, spool ou session store. Crates folha
não dependem do runner. Dependências novas devem seguir o grafo acima; exceções
exigem ADR.

## Organização de código

- Um módulo possui uma responsabilidade e um owner claro.
- Arquivos de domínio devem permanecer pequenos; ao se aproximarem de 250 linhas,
  separar estado, transições, erros ou adapters.
- `lib.rs` e `main.rs` apenas declaram fronteiras e composição.
- Tipos gerados por Protobuf ficam em `agent-protocol/src/generated/v1`;
  nenhum arquivo gerado é criado ou editado manualmente.
- I/O, bindings de plataforma e clients concretos não entram no engine.
- Nenhum canal ou coleção pode nascer sem limite explícito na implementação
  funcional.
- `unsafe` é negado no workspace. Somente módulos mínimos de FFI dentro de
  `agent-platform` podem rebaixar esse lint, com ADR, comentário `SAFETY`,
  testes de plataforma e API pública totalmente safe.

## Toolchain

O workspace fixa Rust 1.97.1 e usa Edition 2024. O toolchain declara os seis
targets de produto:

- Windows x64 e arm64;
- macOS x64 e arm64;
- Linux x64 e arm64.

Com Rust disponível, a validação local é:

```text
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-targets --locked
```

No Windows, `agent-runner` e `agentd-supervisor` já possuem entrypoints
process-real protegidos. O supervisor exige um `SupervisorProcessHandoff`
single-use por handles herdados, conecta um Named Pipe management separado com
peer PID verificado, responde `SupervisorProcessReady` e compõe o loop
`SupervisorAsyncService` permanente. Invocação direta, handoff inválido e
targets ainda sem backend retornam fail-closed com exit code `78`. O launcher
Node-API do Host já cria e autentica esse processo, retém Job + management
stream e comprova Hello/Shutdown/reap process-real. O E2E TS↔supervisor↔runner
já chega a Active e ao reap durável; recovery/rehydration após restart e a
execução funcional do engine continuam bloqueando produção.

O coordenador atual valida lifecycle, ownership e containment sobre portas
tipadas/injetadas. Os adapters one-shot de Named Pipe/Unix socket já possuem
owner linear, controle de acesso local, deadline/cancel nas operações que podem
aguardar e peer check bilateral antes de I/O. No Windows, o spawn contido agora
consome uma allowlist limitada de duplicatas herdáveis dedicadas e combina
`JOB_LIST` com `HANDLE_LIST`; testes de processo reais provam inclusão exata e
exclusão de handles herdáveis alheios. O cleanup Unix atual ainda não é o unlink
descriptor-relative exigido contra replace concorrente.

O bootstrap supervisor→runner já possui IDL próprio gerado para TS/Rust e codec
Rust single-use: valida a forma e autoconsistência dos três endpoints canônicos,
peers declarados, budget e containment, aplica caps de 64 KiB/4 KiB e limite de
token 16..512 bytes, e liga `RunnerEndpointsReady` ao hash dos bytes exatos. No
probe Windows atual, dois pipes anônimos e um `NUL` formam o stdio indivisível
instalado por `HANDLE_LIST` junto do `JOB_LIST`; nenhum valor de handle passa
por argv/env. O runner toma esses handles uma única vez, comprova o PID criador
bilateral, recebe exatamente um handoff seguido de EOF, valida
clock/PID/plataforma, cria os três Named Pipes nos endereços canônicos exatos e
só então envia Ready. Falha de bind ou write derruba os listeners ainda não
transferidos, e o teste físico comprova rebind dos mesmos nomes.

Depois do Ready, o handoff só pode avançar por uma transição tipada que mantém
o contexto control, o verifier ligado ao hash do handoff exato e o launch nonce
no mesmo owner. O nonce entra uma única vez no `AgentHello`; tokens e nonces são
sobrescritos também em decode parcial, early return, erro de write, panic e
drop, e os tipos de diagnóstico não expõem seus bytes. Separadamente, o handoff
carrega somente o `ActivationAuthoritySeal` mintado pelo Host — versões e
`SHA-256(raw activation nonce)`. O supervisor valida e copia esse commitment sem
receber o nonce bruto; o runner exige versões e nonce exatos antes de confirmar
`ActivateAttempt`.

O supervisor também separa `prepare` de `complete_after_spawn`: os handles
existem antes do spawn e os fatos selados incluem identity, runtime, hard
deadline, authority lease, budget, endpoints, launch nonce, activation seal,
digest e peers. Builds de produção não possuem construtor por PID/UID cru nem
mint de receipt; esses caminhos existem somente nos testes. Assim,
`LaunchAccepted` real não pode nascer antes do provisioner físico comprovar
Ready exato, EOF, cleanup do bootstrap e nova amostragem de deadline/lease.
Falha pós-spawn agenda cleanup apenas daquela tentativa.

O provisioner Windows real usa parent ends overlapped, deadline único
`min(hard deadline, authority lease, startup timeout)` e transfere todo I/O
pendente para o reaper. Depois que a admissão fecha e cada attempt física está
agendada para cleanup, `SupervisorCleanupPump` pode tomar o owner e avançar sem
tráfego management. O deadline nasce na transferência; `advance(&mut self)`
preserva owner e deadline sob cancelamento; cada tick é bounded e nonblocking,
com checagem antes e depois; retries rotacionam em round-robin. O resultado é
somente `Drained` ou `HardRestartRequired`, e este último mantém ownership vivo
até o restart. O `main` ainda não executa esse restart.

No caminho target-specific, cada launch protegido instala um watchdog inicial
em `min(hard deadline, authority lease)` sem fechar admission global. O
`SupervisorPhysicalDriver` aceita `CancelAttemptProcess`,
`FenceAttemptProcess` e `ReapAttemptProcess`, resolve a `OwnershipKey` exata e
reserva `idempotency key + digest + causa` em slots bounded do launch ledger
antes de instalar qualquer efeito. O ACK só é escrito depois do schedule e da
intenção scheduled. Replay físico não volta ao handler; retry semântico
idêntico recebe ACK novo sem reagendar, inclusive após reap enquanto a
tombstone bounded estiver retida. Reuso da chave por outro tipo ou attempt
falha fechado dentro dessa janela retida.

O codec valida deadlines positivos, mas deixa a expiração temporal de Cancel e
Reap para o planner depois da consulta ao ledger. Com isso, intenção nova
expirada falha fechado e retry scheduled pós-grace/pós-reap recebe ACK sem
recriar owner. Reject e ACK failure só armam cleanup imediato quando a
`OwnershipKey` ainda existe fisicamente; tombstone não cria schedule fantasma.

Schedules obedecem à precedência `Cancel < Fence < Reap` e só podem manter ou
encurtar deadlines. Cancel valida a grace solicitada contra hard deadline e
`cancel_grace_ms` selado; Fence deriva sua grace desses mesmos limites; Reap
torna imediatamente due também um retry pendente de termination/reap e mantém
`reap_deadline` como ceiling. O core rejeita uma amostra injetada no/após o
ceiling. `SupervisorOnlineLifecycle` conduz o próximo deadline sem depender de
novo frame management, e o owner físico reamostra o clock antes e depois de
termination, cleanup de provisionamento e reap. Igualdade expira; tempo inválido
ou regressivo falha fechado. O gate pós-reap fica dentro do ledger, antes de
publicar sucesso ou liberar admissão: se o backend concluiu mas o gate falha, a
attempt fica `Quarantined` e a reserva permanece contabilizada.
`reap_after_cleanup` preserva exit cooperativo já observado, e disconnect combina
sua grace por mínimo sem alongar o watchdog vigente. Testes também provam que a
sibling permanece intacta, shutdown fecha admissão e agenda todos os owners, ACK
perdido retém schedule/owner/reservation e ceiling expirado não forja reap.
Na biblioteca, `SupervisorAsyncService` já compõe o
`AsyncEstablishedManagementActor`, o `SupervisorOnlineLifecycle` e o pipeline
físico compartilhado de `LaunchAttemptProcess` em um owner único. Launch usa o
mesmo core nos adapters síncrono e assíncrono, responde pelo pending inbound
correlacionado e conduz `LaunchAccepted → AttemptProcessSpawned →
AttemptContainmentReport`, aguardando write/ACK de cada fato. Write já
enfileirado e sua `PreparedLaunchEmission` permanecem no owner do serviço:
cancelar `advance()` não perde payload, receipt, tracking, cleanup owner nem
reservation.

O reap bem-sucedido captura sua prova antes de remover ownership e a move para
uma outbox FIFO bounded por `max_active_attempts`. Capacidade cheia retém o Job
para retry em vez de perder o fato. O writer async prioriza essa outbox, envia
`AttemptProcessExited` e somente seu ACK exato materializa o sucessor
`AttemptProcessReaped`; o ACK final encerra a cadeia. O Host mantém um pump
management owned após `Active`, persiste cada fato no writer de sessão e ACKa
na ordem. Depois do ACK Control, Cancel/Fence também atravessam esse mesmo canal
management, aguardam o ACK exato do schedule Rust e compartilham a sequência
outbound com os ACKs de fatos. O E2E Windows comprova as causas físicas
`CANCELLED`/`FENCED`, os cinco fatos de launch a reap e preserva o supervisor.
A outbox ainda é volátil sob restart do supervisor,
portanto recovery durável continua gate aberto.

Replay físico devolve os mesmos bytes sem repetir efeitos. Retry semântico com
a mesma chave e digest devolve um novo `LaunchAccepted` correlacionado, marcado
como reutilização no resultado interno do driver, sem reprovisionar nem
respawnar, inclusive após reap enquanto o snapshot redigido e bounded estiver
retido. Cancel/Fence/Reap continuam compartilhando o mesmo planner; write
failure fecha admission sem perder schedule ou ownership. ACK tardio depois de
reap confirmado não recria cleanup para owner ausente; a mesma ausência sem
prova no ledger continua sendo erro fail-closed. Essa composição agora é usada
pelo entrypoint Windows depois do bootstrap físico autenticado.

`ShutdownSupervisor` também é executável no serviço async. `Drain` fecha
admission sem encurtar os schedules das attempts e instala um ceiling global;
se owners ainda existirem no ceiling, o serviço exige hard restart sem
descartá-los. `TerminateAfterGrace` fecha admission e agenda cada owner no
menor deadline vigente. A precedência é monotônica: termination pode escalar
drain, nunca o contrário. Um ledger bounded a um slot por modo cobre replay
físico, retry semântico e conflito de chave/digest. A mutação física precede o
ACK, write cancelado é retomável, write failure não desfaz shutdown e o serviço
continua lendo ACK/replay/retry enquanto drena.

O runner já possui um owner Tokio interno que primeiro aceita o supervisor
esperado no endpoint privado de pulse, envia um frame `Negotiating` autenticado
e só então aceita o Host esperado no endpoint control. Em seguida conduz
`AgentHello → HostHello → Prepare → Prepared → Activate → Ack`, mantém
data/pulse e o handoff no mesmo owner e só retorna `Active` depois do commit do
ACK. O sender inicial é então consumido por um pump permanente que emite nas
transições `Hydrating`, `Prepared` e `Active`, além do tick periódico selado no
handoff; missed ticks usam `Skip`, sem burst de recuperação. Futures abandonados
antes do primeiro poll também invalidam nonce/canal; cancelamento, EOF,
deadline, clock inválido, hidratação e write failure fecham a sessão.

Pós-`Active`, um `advance` bounded processa `CancelAttempt` e `FenceAttempt`.
Payload, identity, reason/epoch, deadline e idempotência são validados antes de
revogar effects; a revogação ocorre sincronamente antes do ACK. O lifecycle só
instala `Cancelling` depois do write físico, reamostragem estrita do clock e
receipt ligado ao inbound. Replay físico reutiliza bytes; retry semântico exige
mesmo tipo, chave e digest. Sucesso devolve cleanup tipado ainda dono de
handoff/data/pulse pump; falha ou drop fecha em `Exiting` sem restaurar
authority. Essa API permanece crate-private porque ainda não existe o loop de
effects produtivo nem drain cooperativo.

O entrypoint Windows do `agent-runner` consome o bootstrap herdado real,
confere o PID criador do supervisor, materializa control/data/pulse e entra no
accept/pump. A proveniência do binário só chega ao runner depois de o supervisor
comparar a expectativa do Host com a instalação confiável; o handoff protegido
a liga ao runtime instance e PID físicos. O runner deriva uma chave de pulse
ligada ao endpoint/connection, prova o peer supervisor pelo PID e envia o frame
inicial com contador 1. O supervisor valida HMAC, identity, fase, contador,
progress e resource sample antes de admitir `LaunchAccepted`. Depois do commit,
o receipt instala o monitor no owner permanente do supervisor e o runner emite
com intervalo `pulse_timeout / 3`, recebido do handoff. Então o runner envia
`AgentHello`, aceita somente o PID Host selado e conclui `HostHello`.
No Windows, cada pulse amostra o processo runner corrente por APIs Win32 e
carrega RSS atual/pico, CPU acumulada e número real de handles. Nesta etapa o
runner ainda não abre processos filhos nem spool, portanto `process_count = 1`
e `spool_bytes = 0` são fatos estruturais; o rollup do Job/spool entra junto da
composição dessas capacidades.

Nesta fatia, o session store e seu bridge já oferecem leitura path-free dos
bytes comprometidos, e o runner já verifica/possui os snapshots e artifacts
sob metadata, SHA-256 e budgets selados. O Host TS possui sender Data bounded e
adapter `test|shadow`. O novo `agent-host-bridge` consome um
`HostAttemptBridgeOpenRequest` gerado, revalida launch contra
`LaunchAccepted → Spawned → Containment` duráveis e abre Control/Data somente
depois de verificar o PID do runner nas conexões Named Pipe exatas. Seu owner
tipado retém os dois transports; divergência, deadline ou PID falso falham
fechado. O `agent-host-bridge-napi` já carrega esse core no mesmo processo
Node/Electron, retém os dois transports em um owner Rust, oferece operações
async bounded com cancelamento compartilhado e fecha ambos explicitamente. O
package manifest liga o `.node` aos executáveis e o loader TS só aceita o
artefato verificado. O adapter Host já transforma os reads/writes nativos em
`DelimitedByteChannel`, transfere Control/Data sem reopen e compartilha cleanup
explícito. O E2E process-real TS chega a `AttemptPrepared` e `ActiveAuthority`
com supervisor e runner de produção em processos distintos, prova que ambos
seguem vivos pós-`Active`, fecha/reapeia os dois e cobre hidratação divergente
sem PID órfão. O mesmo launch só é aceito depois do pulse físico inicial; o E2E
também espera 1.200 ms sob timeout negociado de 500 ms e comprova que pulses
periódicos mantêm ambos vivos. Os oito testes Windows físicos executados
separadamente pela CI também percorrem o entrypoint produtivo do fixture de
sucesso.

`prepare`, spawn contido e `complete_after_spawn` executam fora do loop Tokio de
management/lifecycle, em um worker OS dedicado, owned e joinable por launch
pendente. O worker usa stack explícita de 1 MiB e canais de estágio/cleanup
bounded com capacidade 1. O serviço preserva pending inbound, estado físico,
worker, cleanup owner e reservation entre cancelamentos de `advance()`;
watchdog de siblings e shutdown continuam avançando enquanto o efeito físico
bloqueia. Os estados `Launching` e `BootstrapPending` impedem reap prematuro e
spin de cleanup.

O supervisor possui um único runtime Tokio de pulse por processo, não um thread
ou runtime por attempt. Após o commit de `LaunchAccepted`, o
`SupervisorLifecycleCore` retém um monitor bounded por `max_active_attempts` e
somente a observação validada mais recente. Seu próximo wake é o mínimo entre
cleanup, `último pulse + timeout` e hard deadline. Silêncio, framing inválido ou
falha de autenticação removem apenas o monitor alvo e agendam termination/reap
imediato; pulse fresco nunca renova o hard deadline. Drop do monitor encerra o
ator receiver.

Depois de `Active`, o runner também mantém o heartbeat semântico no mesmo
Control stream. Uma leitura ociosa acorda no intervalo negociado sem consumir
bytes nem perder o owner; o sender gera frame novo sequenciado sem `reply_to`,
com liveness/progress/fase e o mesmo sample real do processo. O Host TS mantém
um pump permanente, valida relógios/ratchets/recursos, commita o frame, retém
somente o último snapshot e expira silêncio sem alterar o hard deadline.

O mesmo Control permanece full-duplex para `CancelAttempt`/`FenceAttempt`:
receive e send têm lanes independentes, mas continuam limitados a um reader e
um writer. O Host registra a intenção antes do write, aguarda seu commit antes
de validar resposta precoce e só revoga Active após ACK autenticado. O E2E
Windows já prova Cancel/Fence, ACK e saída do runner mantendo o supervisor vivo;
a sequência management `Exited → Reaped` também é persistida e ACKada no
processo real antes do fechamento do supervisor.

Permanecem pendentes rollup de recursos dos descendentes/Job e bytes reais de
spool, `UpdateAttemptAuthority`, `QuerySupervisorState`, recovery durável da
outbox, coordenação terminal para expor Reap na facade Host, terminal durável, matriz
Windows packaged/nested/breakaway, backend
de spawn Unix e unlink Unix descriptor-relative. Até esses gates, os binários
completam bootstrap, autenticação, hidratação, ativação e liveness físico, mas
recusam trabalho produtivo de agente.

O storage Rust vive em `agent-session-store`. Ele valida IDs UUID canônicos e
layout explícito, cria manifesto imutável `rust_fs_v1`, persiste transições
contíguas de `leaseEpoch + writerId` em authority log hash-chained, adquire um
writer lease exclusivo e liga cada record/receipt a essa authority. O journal
JSONL possui sequência/hash encadeados, payloads content-addressed antes do
record, limites simultâneos, replay idempotente e recovery apenas de tail
incompleta; reopen revalida authority, journal e payloads referenciados.

`session_store.proto` gera os mesmos tipos TS/Prost para
`open/commit/read/query/projection/transfer/archive/close`. A leitura só ocorre
sob writer/authority/operation/kind/hash/tamanho comprometidos exatos, dentro
do cap físico; SHA-256 isolado não é capability. O
`agent-session-bridge` consome frames bounded com instance/sequence/deadline e
hash antes do decode, permanece ligado ao processo que criou seu owner opaco e
resolve somente `root_id` registrado no bootstrap Rust. Open, commit, query,
archive e close já chegam ao store; projection e transfer só podem entrar por
extension port Rust compilado, com validação do receipt. O port default rejeita
ambos fail-closed.

O extension port real já transfere `typescript_fs_v1 → rust_fs_v1` com drain,
inventário/hash, fencing, crash injection e recovery idempotente. Ainda faltam
ACL/handle-relative completa por plataforma, projection writer atômico,
metrics rotation e backup/restore; portanto esse slice isolado ainda não
autoriza o cutover do writer.

## Supply chain

A política inicial está em [SUPPLY_CHAIN.md](./SUPPLY_CHAIN.md). O workspace
mantém o grafo externo mínimo: `prost` implementa o wire Protobuf, `sha2`
implementa os hashes normativos, `zeroize` fornece o scrubbing auditável dos
owners de segredo, `tokio` fornece framing, channels, timers e IPC local, e
`windows-sys` fica restrito ao target Windows de `agent-platform`. Toda nova
dependência exige justificativa de owner, licença, advisory e impacto no binário.
