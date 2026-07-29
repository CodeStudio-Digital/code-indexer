# 02 — Protocolo Host ↔ agentd

> **Status:** normativo  
> **Requisitos:** `IPC-*`  
> **Autoridade futura:** `.proto` em `packages/agent-runtime-contracts/proto`

## 1. Princípios

1. O IDL é a única autoridade cross-language.
2. Bindings Rust/TypeScript são gerados.
3. Domínio e wire possuem adapters explícitos.
4. Controle nunca bloqueia atrás de output.
5. Toda mutação possui identity, deadline, idempotência e fencing.
6. Payload grande vira artifact.
7. EOF de transporte não é terminal de aplicação.
8. Desconhecido crítico falha fechado.

## 2. Layout do IDL

```text
packages/agent-runtime-contracts/proto/codestudio/agent/v1/
  common.proto
  runtime.proto
  provider.proto
  capability.proto
  artifact.proto
  child_run.proto
  telemetry.proto
```

Package Protobuf:

```text
codestudio.agent.v1
```

Outputs:

```text
packages/agent-runtime-contracts/src/generated/v1/
native/agent-runtime/crates/agent-protocol/src/generated/v1/
```

### IPC-001

CI DEVE falhar se outputs gerados não corresponderem aos `.proto`.

### IPC-002

Código gerado não pode ser editado manualmente.

## 3. Representações canônicas

| Conceito de domínio | Wire |
|---|---|
| IDs branded TS | `string` opaca, não obrigatoriamente UUID |
| Sequence/epoch | `uint64`; TS usa `bigint` ou decimal string |
| Timestamp | `int64` Unix milliseconds UTC |
| Duração | `uint64` milliseconds |
| Dinheiro | inteiro de micros na moeda declarada |
| JSON arbitrário | bytes UTF-8 em JSON canônico + schema ref + SHA-256 |
| Hash | 32 bytes SHA-256 |
| Campo opcional | `optional` ou `oneof`, nunca valor sentinela ambíguo |
| Artifact grande | `ArtifactRef` |
| Enum | `UNSPECIFIED = 0`, inválido para efeitos |

### IPC-003

`google.protobuf.Struct` é proibido em payloads de provider/tool/policy. Ele
perde canonicalização numérica e dificulta hash estável.

### IPC-004

`float`/`double` são proibidos para custo e valores de autoridade.

### IPC-005

Unknown enum:

- em telemetria droppable: preservar número e marcar unknown;
- em lifecycle, policy, capability ou terminal: protocol error fail-closed.

## 4. Transporte

### IPC-006

Cada attempt possui dois streams de data plane e um canal privado de pulse,
todos fisicamente independentes:

- **control:** handshake, heartbeat, cancel, fence, ACK, terminal;
- **data:** provider, capability, artifact e live deltas.
- **runner pulse:** liveness físico mínimo, sem payload de agente.

Windows usa Named Pipes; Unix usa Unix domain sockets. TCP local não é default.
Cada endpoint possui `endpointId`, `connectionId`, nome/address local canônico,
token efêmero e cap próprio antes do spawn. Os três `connectionId` são distintos
e permanecem estáveis por toda a conexão:

- **control:** launch, endpoint, handoff, `FrameHeader` de `AgentHello` e
  `HostHello`, e `HostHello.connection_id`;
- **data:** launch, endpoint, handoff e `FrameHeader` de
  `BindAttemptChannel`/`AttemptChannelBound`;
- **runner pulse:** launch, endpoint e handoff protegido. `PulseFrame` não
  repete o ID; sua identidade fica selada pelo handle/FD herdado e pelo
  autenticador por attempt.

No data endpoint, o Host que provisionou o token envia
`BindAttemptChannel`; o runner conserva apenas o verifier endpoint-bound,
valida token, peer, runtime, identity e caps no mesmo stream e só então
responde `AttemptChannelBound`. Exigir que o runner reenvie um token bruto já
scrubbed é proibido.

### IPC-007

Frames são Protobuf length-delimited com:

- máximo absoluto de frame;
- máximo negociado de chunk;
- CRC opcional de transporte;
- hash obrigatório dos bytes opacos de `encoded_payload`;
- hash semântico schema-qualified separado quando o payload representar uma
  spec, snapshot ou intenção;
- read/write deadlines;
- contadores de frames/bytes in-flight.

O prefixo length-delimited é um `uint32` varint canônico de no máximo 5 bytes.
Comprimento zero, encoding não mínimo, overflow, corpo truncado e tamanho acima
do cap são rejeitados antes de alocar o corpo ou executar decode Protobuf.

No control pós-Active, `read_timeout` limita o progresso desde o primeiro byte
até o frame completo; não limita o silêncio entre frames. A espera pelo primeiro
byte permanece limitada pelo hard deadline imutável, cancelamento do owner e
fechamento do transporte. Aplicar `read_timeout` ao idle é proibido: liveness
pertence a heartbeat, runner pulse e lease.

O receptor conserva os bytes originais do corpo Protobuf do envelope até
concluir cap, hash, replay e dispatch. Um erro de framing, transporte parcial,
hash, header, decode Protobuf/oneof, direção, sequência ou replay conflitante envenena
permanentemente o stream físico: nenhum byte posterior é interpretado como
novo frame e o endpoint é fechado. Reutilizar um codec ou stream
dessincronizado é proibido.

Caps absolutos V1:

| Canal físico | Envelope | Cap |
|---|---|---:|
| management | `ManagementFrame` | 64 KiB |
| pulse | `PulseFrame` | 4 KiB |
| control | `Frame` | 256 KiB |
| data | `Frame` | 1 MiB |

### IPC-008

`stdout`/`stderr` nunca transportam protocolo. São logs/diagnóstico limitados.

### IPC-009

Controle tem capacidade reservada. Saturar `data` não impede `CancelAttempt`,
`FenceAttempt`, heartbeat ou terminal ACK.

O primeiro frame Host → runner no data endpoint é obrigatoriamente
`BindAttemptChannel`, com `stream_seq = 1`, identity completa, runtime instance,
canal `DATA` e o token bruto single-use provisionado ao Host. O runner compara
esse candidato com o verifier non-cloneable ligado ao digest do handoff,
connection ID e endpoint `DATA`, apaga o token antes de qualquer `await` de
resposta e só então grava `AttemptChannelBound`. Hydration antes desse commit,
token reenviado pelo runner ou binding de outro endpoint fecham o stream.

Depois do bind, a allowlist e direção V1 do data channel são:

| Direção | Payloads |
|---|---|
| Host → runner | `HydrationManifest`, `HydrationChunk`, `HydrationComplete` |
| runner → Host | `HydrationProgress`, `HydrationCommitted` |

A transação é stop-and-wait, com `max_in_flight_frames = 1`. O
`HydrationManifest` fixa uma lista ordinal exata de snapshot/artifact refs,
tamanhos, total e chunk cap. Seu binding é o `payload_sha256` dos bytes opacos
do próprio `FramePayload`; cada chunk repete esse digest, transfer ID, ordinal
e offset, e possui SHA-256 próprio. `HydrationProgress` concede exatamente o
próximo offset e `max_next_chunk_bytes`. Todo chunk não-final DEVE preencher o
crédito inteiro; o final preenche exatamente o restante do item. Chunk vazio,
curto, longo, fora de ordem ou que cruza item envenena a transferência.

O runner valida antes de alocar que bytes, artifacts, spool e o número total de
frames cabem no budget selado. O accounting inclui bind/bound,
manifest/progress, cada par chunk/progress e complete/committed. Só
`HydrationComplete` com cobertura, tamanhos e hashes exatos produz
`HydrationCommitted` e move os payloads verificados ao owner de preparação.
Replay físico idêntico reutiliza o ACK já bounded e nunca aplica o chunk duas
vezes.

Enquanto essa transação aguarda o data stream, o owner continua selecionando o
control channel. `CancelAttempt`, `FenceAttempt`, replay e hard deadline
revogam/encerram a hidratação sem publicar `Prepared`; backpressure de data
nunca bloqueia o cancelamento de controle.

## 5. Envelope

Forma normativa:

```proto
message FrameHeader {
  uint32 protocol_version = 1;
  string connection_id = 2;
  string message_id = 3;
  optional string reply_to_message_id = 4;

  string session_id = 5;
  string command_id = 6;
  string agent_run_id = 7;
  string attempt_id = 8;
  string executor_owner_id = 9;
  uint64 fencing_epoch = 10;
  string correlation_id = 11;

  uint64 stream_seq = 12;
  int64 sent_at_unix_ms = 13;
  optional int64 deadline_at_unix_ms = 14;
  bytes payload_sha256 = 15;

  optional string operation_id = 16;
  optional string tool_use_id = 17;
  string root_agent_run_id = 18;
  optional string owner_agent_run_id = 19;
  optional string parent_agent_run_id = 20;
}

message Frame {
  FrameHeader header = 1;
  TransportChannel channel = 2;
  bytes encoded_payload = 3;
}

message FramePayload {
  oneof body {
    // mensagens tipadas do canal control ou data
  }
}
```

`protocol_version` usa exatamente `(major << 16) | minor`; ambos os
componentes são `uint16`. O receptor recupera `major` dos 16 bits superiores e
`minor` dos 16 inferiores.

`encoded_payload` contém os bytes Protobuf de exatamente um `FramePayload`.
Antes de qualquer decode interno, o receptor valida cap, presença do header,
canal físico esperado e:

```text
payload_sha256 =
  SHA-256(UTF8("codestudio.agent.frame-payload.v1\0") || encoded_payload)
```

Unknown fields permanecem nos bytes opacos durante essa verificação. Decodificar
e reserializar antes do hash é proibido. `control` aceita apenas handshake e
lifecycle; `data` aceita somente o bind e os payloads de hidratação enumerados
em IPC-009, sempre na direção exata. `management` e `pulse` usam envelopes
próprios e falham se recebidos como `Frame`.

Depois de `HostHello`, cada endpoint possui um `ReceiverContext` imutável com:

- versão exata negociada;
- `connectionId` exato;
- identity completa da attempt, incluindo root/owner/parent e fencing epoch;
- `runtimeInstanceId` associado à conexão;
- canal físico;
- peer emissor e direção permitida.

Todo frame pós-handshake DEVE coincidir com esse contexto antes do decode do
payload tipado. A allowlist é por canal **e direção**: uma mensagem agent→host
recebida pelo runner, ou host→agent recebida pelo host, é protocol violation
mesmo que pertença ao canal correto. Campos duplicados entre header, payload,
`RunnerLaunchContext` e estado durável devem ser exatamente iguais.

O bootstrap anterior a `HostHello` usa um receiver separado e restrito. Ele
aceita somente o `AgentHello`/`HostHello` esperado para sua direção e valida o
nonce e o contexto de lançamento; não aceita `PrepareAttempt`, lifecycle ou
payload de domínio. O owner do bootstrap também possui os dois lados do
transporte. O seed negociado é opaco, single-use e vinculado à instância exata
desse owner; o handoff consome o owner e cria o canal estabelecido sobre o
mesmo byte stream, já estreitado para um cap físico exatamente igual ao limite
negociado. Seed de outro canal, troca de stream ou cap apenas aproximado
envenenam e encerram a conexão.

### IPC-010

`stream_seq` começa em `1` e é exatamente sequencial por conexão, direção e
canal. Para um frame novo, o único valor válido é `lastAccepted + 1`; gap,
regressão ou reordenação não são buffered. Um sequence já observado só pode ser
classificado como replay idêntico conforme IPC-012 e nunca volta ao handler.

Cada direção possui exatamente um `OutboundHeaderAuthority`, privado ao owner
do transporte. Ele reserva e publica `stream_seq`, cria `message_id`, amostra
`sent_at_unix_ms` de clock confiável e fixa `reply_to_message_id`; handlers
fornecem apenas o payload e a política de deadline. Header completo ou sequence
fornecidos por caller são proibidos. A reserva só avança quando o write/commit
correspondente conclui. Somente replay físico do mesmo envelope inbound
retransmite os mesmos bytes e não reserva sequence; retry semântico com novo
`message_id` gera novo header, sequence e `reply_to_message_id`.

Validação não equivale a aceitação. O receiver entrega ao handler um
`PendingInbound` opaco e single-use, sem avançar o watermark nem o histórico.
Somente `commit(PendingInbound, outcome)` produz um receipt de commit
não-forjável, avança sequence e grava o outcome bounded de replay. Falha do
handler chama `reject`, que envenena conjuntamente receiver e transporte.
Enquanto existe um pending, nenhum outro frame pode entrar.

### IPC-011

Mensagem que cria estado/efeito exige identity completa e fence. Mensagem sem
campos obrigatórios é rejeitada antes do handler. Header, payload,
`RunnerLaunchContext`, receiver e autoridade durável devem concordar em todos
os componentes da identity; comparar apenas `attemptId` ou apenas
`fencingEpoch` é proibido.

### IPC-012

`message_id` deduplica entrega; idempotency key deduplica intenção. Um não
substitui o outro.

Em toda mutação, a idempotency key é classificada contra um ledger bounded
**antes** de provisionar endpoint, reservar/spawnar processo ou executar
qualquer outro efeito. Chave nova reserva o digest semântico da intenção; chave
igual com digest igual reutiliza o estado/outcome físico existente sem repetir
efeitos; chave igual com digest diferente falha fechado sem alcançar adapters.
O ledger do supervisor retém apenas IDs, digests e fatos físicos redigidos,
nunca nonce ou token. O command ledger durável do host continua sendo a
autoridade entre reinícios do supervisor. Uma entrada só pode ser evictada
depois de outcome durável/reconciliação explícita do host; antes dessa prova,
exaustão do ledger rejeita nova admissão em vez de esquecer intenção antiga.

O receptor calcula, antes do decode tipado:

```text
envelope_sha256 =
  SHA-256(UTF8("codestudio.agent.frame-envelope.v1\0") || encoded_frame)
```

`encoded_frame` são os bytes Protobuf originais do `Frame`, sem o prefixo
length-delimited e sem decode/reserialização. O replay cache é bounded pelos
limites negociados e indexado por
`connectionId + direção + canal + messageId`. Ele conserva no mínimo
`streamSeq + envelope_sha256 + outcome de dedupe`; quando há resposta, conserva
os bytes completos já limitados pelo cap negociado.

Um replay só é equivalente quando a chave completa do cache, sequence e digest
do envelope original coincidem. Mesmo `messageId` com digest ou sequence
diferente é protocol violation e envenena o stream. Sequence antigo ausente do
cache bounded não é reexecutado: falha fechado porque a equivalência já não
pode ser provada. Evicção do outcome cria tombstone permanente para aquela
conexão; o mesmo `messageId` nunca volta a ser novo. Replay ativo e tombstones
compartilham um limite total explícito; atingir o limite encerra a conexão em
vez de liberar identities antigas para reuso.

O cache também possui `max_replay_bytes`, independente do limite de entradas.
O outcome e o evento de replay físico compartilham o mesmo buffer imutável;
clone proporcional ao frame é proibido. O accounting conta bytes físicos
únicos e a soma de entries, tombstones e buffers nunca pode ultrapassar os
budgets negociados. Sem espaço para registrar com segurança um novo outcome, o
receiver fecha a conexão em vez de aceitar o frame. Buffer de resposta não é
capability transplantável entre canais.

## 6. Handshake em duas fases

### Agent → Host: `AgentHello`

- protocol min/max;
- contract/schema versions;
- build ID, commit e binary digest;
- PID e runtime instance ID;
- nonce de lançamento;
- OS, arquitetura e containment capability;
- feature bits;
- versões/hashes das capabilities nativas.

### Host → Agent: `HostHello`

- versão selecionada;
- connection ID;
- contract/schema version;
- heartbeat interval/timeout;
- frame/chunk/window limits;
- session token da conexão;
- features permitidas.

O handshake é uma transição real, não uma sequência sintetizada pelo handler de
`PrepareAttempt`. O runner envia `AgentHello`, o host valida launch nonce,
provenance e `RunnerLaunchContext`, o host envia `HostHello`, e ambos fixam o
`ReceiverContext`. Antes disso, `PrepareAttempt` é rejeitado. Uma máquina de
estado de lifecycle não pode avançar por `spawning`, `handshaking` ou
`hydrating` apenas porque recebeu Prepare.

O host provisiona endpoint e `expectedConnectionId` antes do spawn e sela ambos
no `RunnerLaunchContext`. O header de `AgentHello`, o header e payload de
`HostHello`, o seed negociado e o canal estabelecido devem usar exatamente esse
ID. Bootstrap não aceita placeholder, troca de connection após o Hello nem
seleção autoconsistente porém diferente do launch; conexão A seguida de
`HostHello` B falha fechado.

As transições de sessão `AgentHelloSent` e `HostHelloAccepted` não fazem parte
da API pública. Uma fachada bootstrap single-use possui simultaneamente sessão,
writer, receiver, sender authority e um único clock monotônico confiável; ela
escreve/commita `AgentHello` sequence 1, recebe o `HostHello` no mesmo stream e
só então consome tudo no handoff. Marcar Hello a partir de um objeto Protobuf
sem receipt físico ou permitir que caller externo forneça timestamp/closure é
proibido.

A ordem também é física: no runner, write/commit de `AgentHello` precede a
leitura de `HostHello`; no host, aceitar `AgentHello` precede write/commit de
`HostHello`. Presença final dos dois flags não substitui essa ordem.

### Host → Agent: `PrepareAttempt`

- identity, `encoded_spec` opaco e `spec_schema_version`;
- checkpoint/transcript refs;
- capability/environment/policy snapshot refs;
- resource budget;
- hashes esperados.

`encoded_spec` contém exatamente um `ResolvedAttemptSpec`. O runner calcula o
hash semântico sobre esses bytes originais e a versão externa antes do decode;
depois exige que `ResolvedAttemptSpec.schema_version` coincida. Re-serializar a
spec aninhada para verificar o hash é proibido, pois removeria unknown fields.

Na V1, `spec_schema_version` externo e
`ResolvedAttemptSpec.schema_version` devem ser exatamente `1`. Versão zero,
mais nova ou não negociada falha fechado; a presença de unknown fields cobertos
pelo hash não autoriza semântica que o receiver V1 não entende. Extensão
executável obrigatória exige nova versão de schema ou feature negociada.

Prepare também deve coincidir exatamente com identity/fence, budget e hard
deadline do `RunnerLaunchContext`. Somente depois de validar frame, handshake,
contexto, hash, versão e a spec completa o runner entra em `hydrating`.

O manifest de hidratação é derivado exclusivamente dos campos tipados da spec:
snapshots de verifier, capability set, environment, workspace lease, policy,
preset e agent definition, além de task/attachments/checkpoint/transcript
quando forem artifacts. `expected_snapshots` não é autoridade independente;
ele deve ser exatamente igual ao manifest derivado. Ausência, extra, duplicate
conflitante, owner session divergente, versão ou hash diferente falham fechado.
Nenhum snapshot/artifact/task é carregado antes dessa validação.

O owner da hidratação deve concluir com `finish_prepare` ou consumir o
`PendingInbound` por `abort_prepare`; perder o token, falhar a hidratação ou
ultrapassar o menor deadline imutável fecha a conexão e limpa manifests,
buffers e estado pendente. `receive_next` não é o reaper: o driver expõe um
tick baseado em seu próprio clock, e o supervisor mantém um hard timer
independente. Nenhum caller fornece o instante observado.

### Agent → Host: `AttemptPrepared`

- runtime instance ID;
- hash da spec;
- hashes dos snapshots carregados;
- refs validadas;
- limits efetivos;
- containment level efetivo;
- timestamp ready.

Antes de transicionar para `prepared`, o runner monta `AttemptPrepared`,
`FramePayload`, `FrameHeader` e o `Frame` completos, calcula os digests sobre os
bytes originais e prova que o envelope final cabe tanto no cap absoluto quanto
no limite negociado do canal control. Medir apenas
`AttemptPrepared.encoded_len()` é insuficiente. O envelope enviado fica no
histórico para replay físico exato; o estado `Prepared` guarda o payload
semântico estável. Um novo Prepare com a mesma idempotency key recebe novo
envelope Agent→Host, sequence e `reply_to`, nunca o envelope antigo. A transição
só é instalada depois que o `PendingInbound` do Prepare é commitado com essa
resposta pelo owner conjunto de transporte e receiver. Falha de encode, cap,
commit ou write fecha o driver e mantém a attempt sem autoridade de efeito;
nunca publica `prepared` como se a resposta tivesse sido entregue.

### Host → Agent: `ActivateAttempt`

- identity/fence atuais;
- run/attempt versions;
- deadline absoluto;
- activation nonce.

Antes do launch, o host gera o nonce bruto e persiste sua autoridade durável.
`LaunchAttemptProcess.activation_authority_seal` carrega somente as versões e
`SHA-256(raw_activation_nonce)`. O supervisor valida esse commitment e o
encaminha sem alterá-lo em `RunnerLaunchHandoff`; nunca recebe o nonce bruto.
Como o handoff exato também sela runtime e endpoint control, o commitment fica
ligado à conexão física materializada. O host compara o grant durável com esse
mesmo seal antes do envio, e o runner repete a comparação antes do ACK.

Activate exige receiver/identity/fence vigentes, hash da spec preparada,
run/attempt versions duráveis, nonce vinculado à conexão e runtime, e deadline
positivo, não expirado e menor ou igual ao deadline imutável do launch/spec.
Aceitar apenas valores não zero não constitui validação de autoridade.

Um Activate válido cria e retém uma única `ActiveAuthority` com identity/fence,
connection/runtime, versões, spec hash, nonce e deadline. Essa autoridade é
revogável e expirável; `CancelAttempt`, `FenceAttempt`, perda de lease,
substituição de epoch, deadline ou fechamento da conexão a invalidam
atomicamente. A validação produz apenas um plano opaco: a autoridade ainda não
existe para consumidores. O driver, que possui privadamente sessão e canal,
commita o `PendingInbound`, recebe um receipt ligado ao mesmo envelope e instala
o plano sem executar callback externo entre essas duas operações. Commit
falho, reject, EOF, poison ou `Drop` do driver jamais deixam autoridade ativa.

Depois do `ActivateAck`, o owner único DEVE permanecer conduzido e reter
control, data, runner pulse e handoff até uma transição terminal. Cancelamento
local, hard deadline, EOF, erro ou abandono desse owner revogam a authority e
produzem ownership de cleanup quando há retorno. Esse lifetime guard não
substitui heartbeat/pulse, cancelamento de operações host-owned, terminal
durável ou reap físico.

O deadline de write do `ActivateAck` é
`min(ActivateAttempt.deadline, write_started_at + HostHello.write_timeout)`.
O owner Tokio usa esse limite para interromper o I/O físico e valida o clock
novamente depois que o write retorna; igualdade com o deadline já é expiração.
O harness síncrono conserva a mesma verificação semântica pós-write, mas o
reaper/process deadline continua sendo o backstop físico. Se bytes do ACK
alcançarem o peer e a verificação posterior falhar, o driver fecha a conexão e
descarta o plano sem instalar `ActiveAuthority`.

### Host → Agent: `CancelAttempt` e `FenceAttempt`

Ambas são mutações idempotentes do control pós-`Active`. O payload repete a
identity/fence exata da attempt e carrega `idempotency_key` não vazia de no
máximo 512 bytes. `reason_code` possui 1..128 bytes, sem NUL, e usa somente
ASCII alfanumérico mais `.`, `_`, `:`, `-`.

`CancelAttempt.reason` deve ser conhecido e diferente de `UNSPECIFIED`. Seu
grace deadline obedece:

```text
observed_at < grace_deadline
grace_deadline <= min(effective_hard_deadline,
                      observed_at + sealed_resource_budget.cancel_grace_ms)
```

`FenceAttempt.replacement_fencing_epoch` deve ser estritamente maior que a
epoch atual e `fenced_at` deve ser positivo e não futuro. O fence invalida a
authority desta instância, mas não reescreve sua identity nem promove sua epoch.

O handler executa uma única transação fail-closed, nesta ordem:

1. valida payload, identity, lifecycle, idempotência e limites;
2. revoga sincronamente o effect gate, antes do primeiro `await` de ACK;
3. grava um `Ack` genérico limitado por write timeout e hard deadline; no
   Cancel, o grace deadline também limita esse ACK;
4. reamostra o clock; regressão ou igualdade com o deadline é falha;
5. liga o receipt não-forjável ao mesmo inbound;
6. somente então instala o cache semântico, transita `Active → Cancelling` e
   publica o outcome tipado.

Write bloqueado, future abandonada, receipt divergente, deadline, regressão ou
erro fecham o canal, mantêm effects revogados e forçam `Exiting`; nunca
restauram authority nem publicam `Cancelling`. Bytes possivelmente observados
pelo peer antes de uma falha pós-write são reconciliados por reap, não por
reativação.

Replay físico exato reutiliza os bytes imutáveis do ACK e não avança sequence.
Retry semântico com novo envelope só é aceito para o mesmo tipo, mesma
`idempotency_key` e mesmo digest de payload; ele recebe ACK novo correlacionado
ao novo `message_id`. Payload divergente, chave diferente ou alternância
Cancel↔Fence fecham por conflito.

O lifetime pós-`Active` converte Cancel/Fence aceitos em cleanup tipado, retém
os recursos lineares e fecha control em `Exiting`. Essa fatia não implementa
drain cooperativo durante a graça, checkpoint/terminal durável, cancelamento
host-owned, bridge ao supervisor ou reap físico; portanto não satisfaz sozinha
os gates de latência/kill.

### IPC-013

Provider/tool execution antes de `ActivateAttempt` é violação crítica.
Provider, tool, capability, child spawn e qualquer mutação exigem um token
`ActiveAuthority` vigente em cada admissão/dispatch. O estado `prepared`, um
booleano consultivo ou a mera posse da spec não substituem esse token. Depois
de revogado ou expirado, cleanup não autoriza novos efeitos.

Uma validação que retorna apenas `true` ou `()` é insuficiente, pois cria TOCTOU
entre check e dispatch. O broker confiável executa a admissão por uma closure
síncrona que recebe um `EffectDispatchPermit` não clonável/não transferível e
mantém o mesmo gate até registrar `dispatch_started`. Revogação usa esse gate:
ou vence antes e impede o dispatch, ou ocorre depois do registro e cancela a
operação já conhecida. Deadline é lido do clock monotônico pertencente ao
driver, nunca de timestamp fornecido pelo chamador da tool/provider.

Até existir esse broker com fila fechável, registro atômico de handle e
cancel/kill de operações in-flight, o runner não expõe token ou callback de
dispatch em sua API pública. Enfileirar trabalho e retornar da closure não
conta como `dispatch_started`: o worker deve revalidar no dequeue ou receber um
handle já registrado pelo gate.

### IPC-014

Um processo preparado não pode ser re-preparado com outra attempt.

## 7. `ResolvedAttemptSpec`

Campos obrigatórios:

- schema/spec version;
- session, command, run, attempt e ordinal;
- trigger: `initial`, `resume`, `provider_fallback`, `worker_recovery`;
- owner/parent/root run IDs e spawn depth;
- role e agent definition;
- task inline limitada ou artifact ref;
- attachment refs;
- requested e effective provider/model/effort/preset;
- downgrade reasons;
- wait mode;
- budgets;
- verifier policy;
- capability set ref/hash/snapshot;
- environment ref/version;
- workspace lease ref/version/fencing;
- policy/preset refs;
- checkpoint/transcript inputs;
- resource budget;
- deadline absoluto.

### IPC-015

`AgentRunSeed` parcial não é aceito como spec executável.

### IPC-016

Todo snapshot possui version, content hash e origem. Ref sem hash verificável
falha na hidratação.

O runner valida a spec completa antes de produzir o manifest: enums
`UNSPECIFIED`, campo obrigatório ausente, provider/binding não resolvido,
run-tree inconsistente, budget implícito ou artifact sem ownership/hash são
protocol errors. Facts carregados devem cobrir exatamente o manifest derivado;
não é permitido declarar `AttemptPrepared` a partir de listas fornecidas fora
da spec.

## 8. Mensagens Host → Agent

| Mensagem | Semântica |
|---|---|
| `HostHello` | Seleciona versão e limites |
| `PrepareAttempt` | Hidrata uma attempt ainda inativa |
| `ActivateAttempt` | Autoriza execução |
| `CancelAttempt` | Cancela com reason e grace deadline |
| `FenceAttempt` | Fecha authority imediatamente |
| `RequestCheckpoint` | Solicita checkpoint/park |
| `InjectMessage` | Entrega command já aceito/idempotente |
| `ResolveInteraction` | Resolve interaction ID exato |
| `UpdateModelBinding` | Atualiza binding resolvido/versionado |
| `ProviderEvent` | Stream/terminal de provider operation |
| `CapabilityUpdate` | Policy/approval/dispatch/progress/terminal |
| `ChildRunUpdate` | Estado/ref/resultado limitado de child |
| `ArtifactCommitAck` | Confirma promoção durável |
| `CheckpointCommitted` | Confirma checkpoint/cursor durable |
| `RunTransitionCommitted` | Confirma waiting/stopping sem terminal lógico |
| `AttemptExitCommitted` | Confirma encerramento durable da attempt sem terminalizar o run |
| `TerminalCommitted` | Confirma barreira terminal |
| `FlowControl` | ACK window, pause e resume |
| `Ping` | Saúde do canal, sem renovar lease por si só |
| `Shutdown` | Encerra processo depois de park/terminal |

## 9. Mensagens Agent → Host

| Mensagem | Semântica |
|---|---|
| `AgentHello` | Negociação/autenticação |
| `AttemptPrepared` | Hidratação concluída, sem efeito |
| `Heartbeat` | Liveness, progresso e recursos |
| `RunTransitionProposal` | Solicita waiting/stopping |
| `AttemptExitProposal` | Solicita saída física não-terminal após checkpoint |
| `CheckpointProposal` | Propõe checkpoint/transcript cursor |
| `TerminalProposal` | Propõe terminal único |
| `InteractionRequest` | Solicita input humano |
| `ProviderStart` | Abre provider operation no host |
| `ProviderCancel` | Cancela provider por operation ID |
| `CapabilityPrepare` | Solicita binding/policy/intent |
| `CapabilityDispatchStarted` | Marca fronteira do efeito |
| `CapabilityTerminal` | Resultado ou unknown |
| `CapabilityCancel` | Cancela tool por operation ID |
| `CapabilityProbe` | Reconcilia sem repetir |
| `SpawnChildRun` | Solicita child run durável |
| `CancelChildRun` | Cancela child por ID |
| `PublishArtifact` | Promove item do spool |
| `RuntimeObservation` | Evento crítico tipado |
| `LiveDelta` | Texto/thinking coalescível |
| `DiagnosticRecord` | Diagnóstico redigido e best-effort |
| `Ack` | Confirma frame crítico |

## 10. Provider Gateway

`ProviderStart` contém:

- operation/provider request IDs;
- provider/model/effort efetivos;
- system prompt e mensagens normalizadas;
- tool specs;
- thinking/inference budget;
- previous response refs;
- cache/session affinity;
- deadline;
- payload inline ou artifact ref.

`ProviderEvent` é `oneof`:

```text
text_delta
thinking_delta
tool_call_start
tool_call_args_delta
tool_call_end
usage
response_meta
response_id
image_artifact
physical_attempt
done
error
```

### IPC-017

OAuth, credentials, retry físico e adapters pertencem ao host.

### IPC-018

Runner decide fallback lógico apenas após terminal tipado do gateway.

### IPC-019

Provider operation registry é bounded e indexado por attempt/operation. Fence
cancela a operação mesmo se o runner já morreu.

## 11. Capability Gateway

`CapabilityPrepare` inclui:

- operation/tool/parent tool IDs;
- capability ID/version;
- canonical input bytes/hash/schema;
- idempotency key;
- descriptor/capability set refs;
- environment/workspace fence;
- deadline;
- nested/background flags.

Estados:

```text
rejected_before_accept
approval_required
accepted
started
progress
terminal
```

`accepted` retorna `SealedExecutionGrant`:

- decision/binding IDs;
- effective input hash;
- capability ID/version;
- environment ID/version;
- workspace lease ID/version/epoch;
- canonical constraints;
- nonce e expiry.

### IPC-020

Para tool nativa:

1. runner envia `CapabilityPrepare`;
2. host resolve environment/policy e persiste boundary;
3. host retorna grant;
4. Rust revalida hash/expiry/fence;
5. Rust envia `CapabilityDispatchStarted`;
6. Rust executa;
7. Rust envia `CapabilityTerminal`.

### IPC-021

Perda de ACK depois de `started` nunca autoriza replay automático.

## 12. Child runs

`SpawnChildRun` contém:

- operation ID e idempotency key;
- root/owner/parent run IDs;
- depth, role e profile;
- task/ref;
- wait mode;
- requested provider/model/effort;
- budget delegado;
- capability/environment profiles.

### IPC-022

Host valida `maxAgents`, `maxDepth`, orçamento global e policy; cria child run e
attempt; supervisor lança processo próprio.

### IPC-023

Pai recebe status, usage, bounded digest e refs. Child transcript nunca é
enviado integralmente ao pai.

## 13. Artifact/spool

`ArtifactRef` contém:

- artifact ID aleatório;
- kind;
- content hash;
- media type;
- byte length;
- compression;
- privacy class;
- redaction policy version.

### IPC-024

Hash não é credencial. Autorização usa artifact ID + owner/session scope.

### IPC-025

Upload/chunk possui tamanho, ordem, hash incremental, janela e ACK.

### IPC-026

Devem virar artifact:

- checkpoint/transcript;
- provider request grande;
- tool result integral;
- imagem/documento;
- child transcript/result;
- diagnóstico/erro grande.

## 14. Flow control

### IPC-027

Janela de frames/bytes não confirmados é bounded por canal.

### IPC-028

Ao saturar:

1. coalescer deltas compatíveis;
2. spoolar conteúdo grande;
3. pausar leitura upstream quando suportado;
4. desconectar consumidor lento de projeção.

Lifecycle, capability boundary, checkpoint e terminal nunca são descartados.

### IPC-029

Somente telemetria explicitamente droppable pode ser perdida; a perda é
contabilizada.

## 15. Terminal

`TerminalProposal` contém:

- classification: `completed`, `failed`, `aborted`, `interrupted`;
- reason code;
- error ref;
- transcript ref obrigatório;
- checkpoint/result refs;
- usage/budget final;
- last emitted sequence;
- terminal payload hash.

### IPC-030

Host só envia `TerminalCommitted` após:

1. validar identity/fence;
2. confirmar transcript legível;
3. persistir terminal da attempt e do `AgentRun`;
4. persistir eventos terminais idempotentes.

O root `SessionCommand` só terminaliza quando o run terminal é o root e sua
completion policy confirma children/verifier obrigatórios. Terminal de child
nunca terminaliza o command por implicação.

### IPC-031

ACK perdido permite reenviar o mesmo proposal. Mesmo ID com payload diferente é
conflito crítico.

### IPC-032

EOF antes de `TerminalCommitted` é crash/interruption, nunca sucesso.

## 16. Compatibilidade

### IPC-033

Handshake negocia major/minor:

- major incompatível: rejeitar;
- minor desconhecido sem feature requerida: permitir;
- feature obrigatória ausente: rejeitar;
- build revogada: rejeitar.

### IPC-034

Campos removidos ficam `reserved`; números de field nunca são reutilizados.

### IPC-035

CI mantém golden binary fixtures por versão suportada e testes de unknown fields.

## 17. Segurança do canal

- endpoint local com ACL do usuário/app e verificação bilateral do processo peer
  antes de expor qualquer byte ao protocolo;
- no Windows: nome canônico local lowercase, DACL protegida para `SYSTEM` e o
  logon SID atual, `FILE_FLAG_FIRST_PIPE_INSTANCE`, uma instância,
  `PIPE_REJECT_REMOTE_CLIENTS` e PID exato via
  `GetNamedPipeClientProcessId` no listener e
  `GetNamedPipeServerProcessId` no client;
- no Unix: pathname absoluto sob root app-private real `0700`, leaf exclusivo
  `0700`, socket `0600`, identidade `dev + ino + tipo` antes de unlink e
  `peer_cred` bilateral com PID/UID exatos; abstract namespace, traversal,
  symlink e reutilização de endereço stale são proibidos. O gate exige cleanup
  descriptor-relative ou prova equivalente que impeça replace entre check e
  unlink;
- o adapter Host de produção é um bridge Rust carregado in-process. Ele cria o
  owner opaco, consulta PID/UID no mesmo HANDLE/FD usado pelo protocolo e
  transfere atomicamente o transporte verificado ou um owner de cleanup para o
  reaper nativo. JavaScript não pode construir esse owner nem fornecer o PID
  como prova; autenticar por probe, fechar/reabrir o endpoint ou retransmitir
  frames por outro processo é proibido;
- nonce de lançamento de uso único;
- `management_session_token` provisionado pela autoridade de bootstrap
  protegida pelo SO e ecoado no primeiro `HostSupervisorHello`, depois da
  verificação física do peer; tokens das attempts atravessam apenas o management
  já estabelecido e o handoff protegido ao runner, nunca argv/env;
- todo token efêmero de sessão ou endpoint deste protocolo possui 16..512 bytes;
  limites maiores no management, handoff ou Hello são proibidos;
- proteção contra processo stale/replay;
- frame/payload size validados antes de alocar;
- logs nunca registram payload bruto;
- credenciais de provider/tool são handles opacos; nonce e token de sessão são
  autenticadores efêmeros do transporte, não credenciais reutilizáveis;
- buffers locais com nonce/token pertencem a owners `zeroize` single-use:
  tokens de endpoint viram hashes privados no decode; o launch nonce cru fica
  inacessível a clones/logs até gravar e confirmar o commit de `AgentHello`, e é
  zerado então ou em qualquer reject, erro, replay e drop de pending;
  registries/outbox retêm somente IDs, digests, tamanhos e fatos redigidos,
  nunca o frame codificado secreto.

## 18. Management Host ↔ Supervisor

O canal permanente do supervisor é separado dos canais de attempts.

Host → Supervisor:

| Mensagem | Semântica |
|---|---|
| `HostSupervisorHello` | Seleciona versão, build policy e limites globais |
| `LaunchAttemptProcess` | Solicita processo/resource group com identity, budget, deadline, launch nonce, activation authority seal e endpoints protegidos |
| `UpdateAttemptAuthority` | Atualiza lease expiry/fence sem ultrapassar hard deadline |
| `CancelAttemptProcess` | Inicia grace física da attempt |
| `FenceAttemptProcess` | Fecha admissão física imediatamente |
| `ReapAttemptProcess` | Exige encerramento e coleta de todos os recursos |
| `QuerySupervisorState` | Reconcilia tabela de PIDs/resource groups |
| `ShutdownSupervisor` | Para admission e encerra árvores conforme policy |

#### Shutdown transacional

`ShutdownSupervisor` possui dois modos monotônicos:

- `Drain` fecha admission imediatamente, preserva os schedules físicos já
  instalados e registra `shutdown_deadline_at` como ceiling global. Se algum
  owner sobreviver ao ceiling, o resultado é hard restart com ownership retido;
- `TerminateAfterGrace` fecha admission e agenda todos os owners em
  `min(deadline vigente, shutdown_deadline_at)`, removendo o ceiling de drain
  porque a terminação física passa a ser a convergência;
- `TerminateAfterGrace` pode escalar `Drain`; `Drain` posterior é subsumido e
  nunca alonga ou enfraquece a terminação.

O ledger é bounded a um slot por modo. Mesma chave e digest é retry semântico;
mesma chave com digest diferente falha fechado; replay físico continua
byte-identical no ator. Admission, ledger e deadlines são mutados antes do ACK.
Write bloqueado/cancelado permanece owned e retomável; write failure não desfaz
o shutdown. Enquanto houver owners, o loop em draining continua consumindo
ACKs, replay e retries e selecionando o lifecycle no mesmo owner.

#### Bridge target-specific de termination

Ao concluir um launch protegido, o supervisor registra um watchdog físico para
a `OwnershipKey` exata em
`min(hard_deadline_at, authority_lease_expires_at)`. O registro nasce antes do
ACK de launch tornar a attempt utilizável e continua válido mesmo sem novo
tráfego management.

Os comandos `CancelAttemptProcess`, `FenceAttemptProcess` e
`ReapAttemptProcess` reutilizam o registro bounded de launch, com no máximo um
slot de intenção por tipo e attempt. Identity completa, idempotency key, digest
dos bytes opacos e causa tipada são classificados antes de qualquer efeito.
`ReapAttemptProcess` também exige o `runtimeInstanceId` vigente.

A transação física é:

```text
validar forma e identity codificada
  → localizar/classificar tombstone bounded
  → para intenção nova, validar owner/runtime/deadline vigente
  → reservar intenção
  → instalar schedule monotônico
  → marcar intenção scheduled
  → commit/write de ManagementAck
```

O schedule e o owner não são desfeitos se o write do ACK falhar. Nesse caso, o
canal fecha, admission global é bloqueada e cleanup continua fail-closed.
Replay físico retransmite o mesmo ACK sem voltar ao handler. Retry semântico
com o mesmo tipo, chave, digest e causa recebe novo ACK correlacionado sem
repetir o schedule, inclusive depois do reap enquanto a tombstone bounded
continuar retida. Uma idempotency key já usada por outro tipo ou attempt é
conflito enquanto sua tombstone bounded existir; divergência envenena o canal.
`graceDeadline` e `reapDeadline` positivos podem chegar ao ledger mesmo após
expirar: o planner rejeita uma intenção nova expirada, mas uma intenção
scheduled idêntica continua ACKável. Cleanup imediato após reject ou falha de
ACK só usa ownership física ainda viva; a chave retida na tombstone não agenda
trabalho físico.

A precedência crescente `Cancel < Fence < Reap` é monotônica. Um comando mais
forte pode antecipar cleanup, mas um comando posterior nunca alonga o deadline
mais cedo nem reduz a causa instalada:

- Cancel aceita somente
  `observedAt < graceDeadline <=
  min(hardDeadline, observedAt + sealed cancelGraceMs)`;
- Fence calcula sua grace física por
  `min(hardDeadline, observedAt + sealed cancelGraceMs)`;
- Reap torna a fase física pendente due em `observedAt`, inclusive retry de
  termination ou reap, e sela `reapDeadline` como ceiling absoluto do cleanup.

O cleanup tick DEVE reamostrar o owner clock antes e depois de termination,
cleanup de I/O e reap. Ao atingir o ceiling, o resultado exige restart duro e
preserva a mesma ownership/reservation. Depois de cleanup, o reaper aceita estado
`Cancelling` ou `Exited`; se o root já saiu cooperativamente, o exit observado
é preservado enquanto descendants são encerrados e coletados.

Esse bridge é target-specific: cancelar uma attempt não fecha admission global
nem altera a sibling. O `SupervisorCleanupPump` que toma o owner inteiro
continua reservado ao caminho em que admission já está fechada e todas as
attempts estão cobertas por cleanup.

Supervisor → Host:

| Mensagem | Semântica |
|---|---|
| `SupervisorHello` | Build, PID, platform e features de containment |
| `LaunchAccepted` / `LaunchRejected` | Resultado da reserva e criação |
| `AttemptProcessSpawned` | PID, runtime instance e resource group |
| `ContainmentReport` | Limites solicitados, aplicados e não suportados |
| `AttemptProcessExited` | Exit facts ainda não duráveis |
| `AttemptProcessReaped` | Confirma ausência de descendants/handles/scratch |
| `SupervisorResourceSample` | Métricas agregadas bounded |
| `SupervisorFault` | Falha física/protocolo redigida |

### IPC-036

O management channel é bounded e NÃO transporta prompt, transcript, provider
frames, tool input/output, artifact body ou live delta.

`ManagementFrame.encoded_payload` contém exatamente um `ManagementPayload`.
O envelope original é limitado a 64 KiB antes do decode; depois, presença do
header e digest de 32 bytes são validados sobre os bytes ainda opacos:

```text
payload_sha256 =
  SHA-256(UTF8("codestudio.agent.management-payload.v1\0") || encoded_payload)
```

Esse hash prova integridade, não autenticação. O `management_session_token` não
é negociado por frames ainda não autenticados: ele é provisionado separadamente
pela autoridade de bootstrap protegida pelo SO. O primeiro
`HostSupervisorHello` prova posse depois do peer check físico, e
`SupervisorHello` conclui a sessão. Unknown fields continuam cobertos pelo hash
e o oneof management é obrigatório.

### IPC-037

Os canais `control` e `data` de uma attempt ligam runner e host diretamente. O
supervisor cria ou transmite endpoints/handles protegidos, mas não retransmite
frames.

### IPC-038

Supervisor reporta fatos físicos. Ele nunca cria command/run/attempt, atribui
`globalSeq`, abre bundle de sessão ou envia `TerminalCommitted`. Persistência é
responsabilidade separada do Rust session store.

### IPC-039

`LaunchAttemptProcess` contém apenas material necessário ao isolamento e
bootstrap. Task, snapshots e capabilities chegam depois por `PrepareAttempt`;
credenciais e conexão de DB nunca são entregues.

O launch aceito produz um `RunnerLaunchContext` imutável, transmitido ao runner
por handle/endpoint protegido e nunca por argv. Ele é derivado exclusivamente
da transação `LaunchAttemptProcess` e da verificação física do supervisor, e
contém:

- identity completa e fencing epoch;
- `runtimeInstanceId`;
- mapa imutável dos três `expectedConnectionId` dos endpoints já
  provisionados;
- launch nonce de uso único;
- `ActivationAuthoritySeal` host-minted, sem o activation nonce bruto;
- hard deadline imutável;
- `ResourceBudget` reservado/aplicado;
- nível, capabilities e limit set de containment efetivamente provados.

O provisionamento protegido retorna ownership linear e revogável. Antes da
transferência comprovada ao processo contido, drop, erro, expiry ou cancel
fecham os endpoints e invalidam tokens; depois da transferência, esse cleanup
passa ao resource group/registro físico. Um receipt de sucesso que contenha
apenas hashes, sem rollback ou transferência física de ownership, não habilita
o binário de produção.

Para endpoints por attempt, o host cria as identidades, connection IDs, tokens
e nomes lógicos na transação. O supervisor transfere o
`RunnerLaunchContext` somente por bootstrap capability-only single-use com
handles/FDs exatos, nunca pelo pathname dos três canais. No Windows, o
bootstrap usa dois pares de Named Pipes privados com nomes aleatórios nunca
serializados: as pontas do supervisor são overlapped/canceláveis e as pontas
síncronas do child entram apenas pela `HANDLE_LIST`; `CreatePipe` síncrono é
aceitável somente em probes. O próprio runner contido cria os Named Pipes de
control/data/pulse e devolve `EndpointsReady`; um pipe criado no supervisor
continuaria reportando o PID do supervisor mesmo após herança. No Unix, o
supervisor pode transferir sockets já bindados, mas ainda sem `listen()`; o
runner passa a escutar somente depois do handoff. O host abre o lado client
diretamente contra o runner, e o supervisor jamais retransmite frames.

Handles/FDs de bootstrap são instalados no processo antes da primeira instrução:
pela `HANDLE_LIST` durante o spawn suspenso no Windows e pelo setup de child
anterior ao `exec` no Unix. O frame não é pré-carregado antes de `ResumeThread`
ou do spawn. Depois que o processo inicia/resume, o runner entra imediatamente
em receive bloqueante e exclusivo do bootstrap; o supervisor só então envia o
handoff. Nenhuma task, snapshot, capability ou abertura dos três canais pode
ocorrer nesse intervalo.

O bootstrap inteiro usa um único deadline monotônico efetivo, igual ao mínimo
entre hard deadline da attempt, expiry da authority lease e startup timeout
local. No Windows, `CancelIoEx` não autoriza liberar `OVERLAPPED`, evento,
buffer ou handles antes da conclusão comprovada; timeout transfere esse owner
ao mesmo registro físico/reaper da attempt. Thread auxiliar destacada e
`CancelSynchronousIo` são proibidos no provisioner de produção.
O outcome de completion é tipado como sucesso ou falha com cleanup owner; um
`Result<Receipt, Error>` que descarte `OVERLAPPED`, evento, buffer ou handles no
ramo `Err` não é uma implementação válida deste contrato.

O reaper termina primeiro o Job da attempt e só então tenta comprovar, de forma
não bloqueante, a conclusão/cancelamento do I/O de bootstrap. Enquanto o cleanup
owner existir, o Job, a reserva de admissão e o registro físico não podem ser
liberados. Falhas transitórias são repetidas com limite explícito; ao exceder o
limite, o supervisor fecha a admissão, preserva o owner e retorna um estado
tipado que exige restart duro do processo. Destruir acidentalmente um owner
ainda pendente é uma violação de invariante process-fatal e não pode transformar
`Drop` em espera ilimitada nem liberar memória ainda referenciada pelo kernel.

O contrato wire privado dessa transferência é
`codestudio/agent/v1/runner_bootstrap.proto`. Ele não pertence a
`ManagementPayload` nem a `FramePayload` e admite exatamente um
`RunnerLaunchHandoff` supervisor→runner seguido por um
`RunnerEndpointsReady` runner→supervisor. Os caps imutáveis, aplicados antes de
qualquer decode, são 64 KiB e 4 KiB, respectivamente.

`RunnerLaunchHandoff` V1 sela:

- schema version, identity completa, runtime instance e PID esperado do runner;
- exatamente três endpoints, na ordem canônica `CONTROL`, `DATA`,
  `RUNNER_PULSE`, com endpoint ID, address, connection ID, token, cap, modo de
  provisionamento, slot lógico e peer role;
- launch nonce, `ActivationAuthoritySeal`, hard deadline, budget reservado,
  containment efetivo e digest do `ManagementPayload` de launch original;
- PID esperado do host e do supervisor; no Unix, também os UIDs esperados.
- `RuntimeProvenance` somente depois de a expectativa do Host coincidir com a
  configuração confiável do supervisor, ligada ao runtime instance e PID
  físicos do spawn.

Todos os IDs, addresses, connection IDs e tokens dos três endpoints são
não-vazios e únicos. Nonce possui 16..256 bytes, token possui 16..512 bytes e
os caps são exatamente 256 KiB para control, 1 MiB para data e 4 KiB para
pulse. Budget é não-zero e internamente consistente. Containment classifica
cada um dos sete limits exatamente uma vez e não pode ser `UNSPECIFIED` nem
`UNAVAILABLE`.

No Windows, os três endpoints usam `WINDOWS_CREATE_NAMED_PIPE`, não carregam
listener slot e o runner cria os listeners. No Unix, usam
`UNIX_RECEIVE_BOUND_SOCKET` e os slots lógicos `CONTROL`, `DATA` e
`RUNNER_PULSE` correspondem exatamente à ordem dos FDs transferidos via
`SCM_RIGHTS`. HANDLE/FD numérico nunca é serializado. Control/data esperam o
PID/UID do host; pulse espera o PID/UID do supervisor. PIDs de host, supervisor
e runner são positivos e distintos.

O ready reconhece os bytes Protobuf originais, antes de decode/re-encode:

```text
acknowledged_handoff_sha256 =
  SHA-256(
    UTF8("codestudio.agent.runner-launch-handoff.v1\0") ||
    exact_encoded_runner_launch_handoff
  )
```

Identity, runtime instance, runner PID e o mapa canônico completo de endpoints
precisam coincidir. A comparação do digest é constant-time. O envio consome o
owner `PreparedRunnerLaunchHandoff` e só depois do write/commit produz
`AwaitingRunnerEndpointsReady`; o frame secreto não possui accessor público
reutilizável. Validar o ready consome esse segundo owner, portanto replay não
possui segunda chamada válida. Erro ou drop em qualquer transição apaga o buffer
com `zeroize`.

No runner, o decode produz `ShapeValidatedRunnerLaunchHandoff`: ele prova cap,
schema, presença, enums, ordem, unicidade e autoconsistência dos campos, mas não
prova que o conteúdo corresponde ao `LaunchPlan`, que a deadline ainda está
viva no relógio confiável, que o modo corresponde à plataforma corrente, nem
que PID/UID/HANDLE/FD, creator/listener e ownership são reais. Essa autoridade
vem somente do adapter físico e do registro no reaper; a validação de forma
isolada não pode produzir o ready de produção.

Durante o decode, tokens crus saem do Protobuf, são transformados em hashes
privados domain-separated ligados ao connection ID e são apagados. O launch
nonce cru precisa sobreviver para o `AgentHello`: ele permanece em memória
`zeroize`, dentro de owner privado non-cloneable e single-use, até a gravação e
o commit desse frame. Sucesso, reject, erro, timeout, replay ou drop apagam o
nonce; nenhum registry, outbox ou fato durável o retém.

O activation nonce bruto nunca atravessa o supervisor nem esse bootstrap. O
runner retém somente o commitment validado até receber `ActivateAttempt` pelo
control autenticado; versões divergentes ou digest diferente fecham a attempt
sem publicar autoridade.

`RunnerEndpointsReady` prova somente que o peer respondeu pelo bootstrap
protegido com o binding correto. Ele não prova creator PID, DACL, `listen()`,
registro no resource group nem ownership do cleanup. O receipt de produção só
pode nascer depois de Ready exato, EOF, I/O de bootstrap comprovadamente
encerrado, provas físicas do adapter e nova amostragem de deadline/lease.
Registrar `WindowsBootstrapCleanup` com I/O ainda pendente no reaper é caminho
de timeout/cancel e nunca autoriza receipt. Frame extra, tamanho, schema, enum,
slot, peer, digest ou mapa divergente encerram o bootstrap sem retry e
encaminham o grupo ao cleanup.

No processo Windows, o mesmo owner produz um `AgentHello` sem nonce a partir
somente da proveniência e das capabilities seladas; o owner single-use injeta o
nonce no commit. O accept verifica o PID do Host antes de I/O semântico. O E2E
físico usa processos distintos para supervisor, runner e Host, valida
proveniência/nonce e conclui `HostHello` no Named Pipe real. Essa prova não
autoriza preparação. O `session_store.proto` agora permite ao bridge Rust ler
um payload comprometido sem expor path, mas somente sob
`writer_handle + authority + operation_id + kind + SHA-256 + byte_length`
exatos e dentro do cap da resposta. Hash isolado nunca é capability. O runner
também possui o owner e o adapter físico do data channel: o primeiro frame
Host → runner autentica token/identity/runtime por typestate, negocia
stop-and-wait, e o pump conduz manifest/chunks/complete com ACK transacional,
budget de bytes/frames, hashes e zeroization. O control permanece selecionável
para Cancel/Fence durante a hidratação, e o stream autenticado passa ao owner
pós-Active. No Host, o framing estabelecido é channel-sealed para Control/Data
e o sender Data `test|shadow` possui typestate `pending → bound`, bind
single-use, stop-and-wait, crédito exato e leitura incremental do bundle
filesystem sem agregar payload no heap. O adapter liga o endpoint autenticado
aos fatos duráveis de launch e `Prepare` só admite `AttemptPrepared` depois do
`HydrationCommitted`. O IDL também define
`HostAttemptBridgeOpenRequest = launch + accepted + spawned + containment +
open deadline + containment requerido`. O core `agent-host-bridge` consome
esse frame uma vez, apaga os segredos decodificados, revalida identity, budget,
proveniência, containment, tempos e conjunto exato de endpoints e só então
abre Control/Data verificando o PID no próprio Named Pipe. Ele devolve um owner
Rust único dos dois transports; erro ao abrir Data descarta Control.
O wrapper `agent-host-bridge-napi` já carrega esse core in-process a partir do
pacote verificado, mantém os transports no Rust, fornece I/O async bounded,
cancelamento comum e close explícito sem probe/reopen. A promoção continua
bloqueada até o adapter TS ligar esse owner ao framing/driver e o E2E Named
Pipe Host TS↔runner comprovar Prepare/Activate; sem essa prova física, a attempt
expira fail-closed sem `ActiveAuthority`.

Prepare/HostHello não podem criar, substituir ou ampliar esse contexto. Budget,
deadline ou containment mais permissivos que o launch falham fechado. O
contexto não contém task, transcript, prompt, credenciais ou body de artifact.

Todo resultado/fato Supervisor → Host permanece outstanding até um
`ManagementAck` correlacionado ao `message_id` e ao digest exatos. O supervisor
emite no máximo a janela negociada; com `max_in_flight_frames = 1`, a sequência
de launch é `LaunchAccepted → ACK → AttemptProcessSpawned → ACK →
ContainmentReport → ACK`. `LaunchRejected` também exige ACK. ACK desconhecido,
divergente, fora de ordem ou duplicado nunca avança a continuação e falha
fechado conforme o estado do canal. Para outcomes e fatos de lifecycle, o host
só envia o ACK depois de receber o receipt do Rust writer do bundle
(`Rust commit → receipt → ACK`, nunca `ACK → commit`); essa é a prova que torna
a tombstone elegível para eviction bounded. Durante a geração transitória
`typescript_fs_v1`, a mesma fachada pode usar o writer legado, mas nunca ambos.

### IPC-040

Se o management channel com o host cair, o supervisor bloqueia novos launches,
não renova deadline/authority e encerra as attempts depois da grace configurada.
O deadline de disconnect é combinado por mínimo com watchdog ou termination já
instalado; a queda do canal nunca alonga hard deadline, lease, Cancel, Fence ou
Reap.
Reconexão exige novo connection ID e reconciliação por
`attemptId + runtimeInstanceId + fencingEpoch`.

O core atual expõe um tick owner-clock bounded, e
`SupervisorAsyncService` já o serializa com o ator management assíncrono e com o
pipeline compartilhado de `LaunchAttemptProcess` em um owner único. O serviço
retém writes e continuações entre cancelamentos de `advance()`, mantém o tick
ativo durante backpressure e conduz a cadeia receipt-tracked de fatos do Launch.
Replay físico não volta ao handler; retry semântico reutiliza o accepted
snapshot bounded sem repetir provisionamento ou spawn, inclusive após reap.
`ShutdownSupervisor` também está ligado a esse owner: `Drain` e
`TerminateAfterGrace` são monotônicos, idempotentes e ACKados somente depois da
mutação física; o loop continua lendo management durante o drain.

A execução física de `prepare`, spawn contido e `complete_after_spawn` já foi
movida para um worker OS dedicado, owned e joinable por launch pendente, fora do
loop Tokio de management/lifecycle. Canais bounded e ownership preservado sob
cancelamento permitem que watchdog de siblings e shutdown continuem avançando
mesmo quando o efeito físico bloqueia. A composição produtiva ainda DEVE ligar
esse serviço ao processo real. Permanecem pendentes
`UpdateAttemptAuthority`, `QuerySupervisorState`, outbox e ACK durável de
`AttemptProcessExited`/`AttemptProcessReaped`; os `main` permanecem scaffolds
fail-closed e o E2E com o Host TypeScript real ainda não existe.

## 19. Invariantes cross-cutting

### IPC-041

Waiting exige `CheckpointCommitted` e `RunTransitionCommitted` antes de
uma saída cooperativa. Depois, `AttemptExitProposal/Committed` terminaliza a
attempt física e mantém o `AgentRun` lógico `waiting` para uma futura attempt
`resume`. O host PODE projetar esse run como `detached` quando nenhum caller
estiver anexado; essa projeção não vem do runner.

### IPC-042

O wire distingue três conceitos: status lógico do `AgentRun`, status durable da
`AgentRunAttempt` e causa física de saída do processo. `TerminalProposal` só
propõe terminal lógico; `checkpointed_waiting` e
`superseded_provider_fallback` são causas físicas, não novas classificações de
terminal do run.

### IPC-043

“JSON canônico” significa RFC 8785/JCS sobre UTF-8 e o subconjunto I-JSON.
Valores não finitos são rejeitados. Inteiros `uint64`, epochs, dinheiro e
qualquer valor fora da representação interoperável NÃO usam JSON number; usam
campo Protobuf tipado ou decimal string validada.

### IPC-044

Hash semântico usa domain separator, schema ID/version e bytes canônicos, não
apenas o texto JSON. Rust e TypeScript DEVEM produzir o mesmo hash para golden
fixtures e rejeitar canonicalizações divergentes antes de policy/idempotência.

Preimage normativo, sem delimitadores implícitos:

```text
UTF8("codestudio.agent.semantic-sha256.v1\0") ||
u32be(byte_length(UTF8(schema_id))) ||
UTF8(schema_id) ||
u32be(schema_version) ||
u64be(byte_length(canonical_bytes)) ||
canonical_bytes
```

`schema_id` não pode ser vazio, `schema_version` começa em 1, e os comprimentos
são contados em bytes. A fixture compartilhada
`packages/agent-runtime-contracts/fixtures/v1/semantic-hash-*` é a autoridade de
paridade TS/Rust.

### IPC-045

`AttemptExitProposal` contém disposition, checkpoint/transcript refs, usage,
último sequence e hash. Dispositions V1:

```text
checkpointed_waiting
superseded_provider_fallback
parked_host_shutdown
```

O host envia `AttemptExitCommitted` somente depois de terminalizar a attempt,
liberar sua lease/fence e preservar o `AgentRun` como não terminal. Waiting e
provider fallback não usam `TerminalProposal`.

### IPC-046

Terminal de child atualiza somente child attempt/run e notifica o pai. O
terminal do root command é avaliado separadamente pela completion policy do
root; nenhum ACK de child pode fechá-lo diretamente.

### IPC-047

Cada runner mantém com o supervisor um pulse channel privado, autenticado,
bounded e sem payload de domínio. `RunnerPulse` carrega somente
`attemptId + runtimeInstanceId + fencingEpoch`, fase, monotonic counter,
`lastProgressSeq` e resource sample pequeno.

### IPC-048

O host envia `UpdateAttemptAuthority` pelo management channel com epoch e
`leaseExpiresAt`. O supervisor nunca cria/estende authority, limita qualquer
update ao hard deadline imutável e encerra o resource group quando lease ou
pulse expira. Assim, host travado com pipe ainda aberto não mantém attempt viva.

## 20. Verificação obrigatória

| Área | Prova |
|---|---|
| Codegen | Rust/TS round-trip e diff limpo |
| Numeric safety | uint64 > `Number.MAX_SAFE_INTEGER` preservado |
| Canonical JSON | hash idêntico Rust/TS |
| Handshake | matriz major/minor/features/build e handoff no mesmo stream |
| Receiver | versão/connection/identity/canal/direção divergentes rejeitados antes do handler |
| Sequence/replay | pending/commit/reject, successor exato, outcome bounded, tombstones, conflito e poison conjunto |
| Identity | launch/header/payload stale PID/attempt/fence rejeitado |
| Prepare | schema V1, manifest derivado da spec e ausência de I/O pré-validação |
| Prepared | envelope completo cabe no cap e só instala estado após commit/write |
| Activate | commit receipt precede authority; close/drop revoga; deadline/nonce/versões; pós-ACK cobre idle, cancel local, hard deadline, EOF, frame parcial e future abandonada |
| Backpressure | data saturado não bloqueia cancel control |
| Management | payload grande rejeitado e supervisor não aparece no data path |
| Termination management | target stale, replay/retry/conflito, precedência Cancel/Fence/Reap, ACK perdido, deadline monotônico, ceiling e sibling isolada |
| Provider | deltas, usage, retry físico, cancel e EOF |
| Capability | allow/ask/deny, guard sem TOCTOU no dispatch e unknown |
| Artifact | chunk, quota, hash mismatch e resume |
| Terminal | ACK perdido, duplicate igual e conflito |
| Waiting | checkpoint + transition ACK, exit físico e resume em attempt nova |
| Fallback | exit não-terminal e nova attempt/epoch sem fechar o run |
| Liveness | host stall, pulse stall e lease expiry convergem para reap |
| Fuzz | framing, unknown fields, oversized payload e invalid enum |
