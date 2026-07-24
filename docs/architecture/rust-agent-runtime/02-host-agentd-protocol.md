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

Cada attempt possui dois streams físicos independentes:

- **control:** handshake, heartbeat, cancel, fence, ACK, terminal;
- **data:** provider, capability, artifact e live deltas.

Windows usa Named Pipes; Unix usa Unix domain sockets. TCP local não é default.

### IPC-007

Frames são Protobuf length-delimited com:

- máximo absoluto de frame;
- máximo negociado de chunk;
- CRC opcional de transporte;
- hash obrigatório do payload semântico;
- read/write deadlines;
- contadores de frames/bytes in-flight.

### IPC-008

`stdout`/`stderr` nunca transportam protocolo. São logs/diagnóstico limitados.

### IPC-009

Controle tem capacidade reservada. Saturar `data` não impede `CancelAttempt`,
`FenceAttempt`, heartbeat ou terminal ACK.

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
}
```

### IPC-010

`stream_seq` é monotônico por conexão, direção e canal.

### IPC-011

Mensagem que cria estado/efeito exige identity completa e fence. Mensagem sem
campos obrigatórios é rejeitada antes do handler.

### IPC-012

`message_id` deduplica entrega; idempotency key deduplica intenção. Um não
substitui o outro.

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

### Host → Agent: `PrepareAttempt`

- identity e `ResolvedAttemptSpec`;
- checkpoint/transcript refs;
- capability/environment/policy snapshot refs;
- resource budget;
- hashes esperados.

### Agent → Host: `AttemptPrepared`

- runtime instance ID;
- hash da spec;
- hashes dos snapshots carregados;
- refs validadas;
- limits efetivos;
- containment level efetivo;
- timestamp ready.

### Host → Agent: `ActivateAttempt`

- identity/fence atuais;
- run/attempt versions;
- deadline absoluto;
- activation nonce.

### IPC-013

Provider/tool execution antes de `ActivateAttempt` é violação crítica.

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
| `RunTransitionProposal` | Solicita waiting/detached/stopping |
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
3. persistir attempt/run/root command;
4. persistir eventos terminais idempotentes.

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

- endpoint local com ACL do usuário/app;
- nonce de lançamento de uso único;
- token de conexão transmitido por handle protegido, não argv;
- proteção contra processo stale/replay;
- frame/payload size validados antes de alocar;
- logs nunca registram payload bruto;
- secrets são handles opacos.

## 18. Verificação obrigatória

| Área | Prova |
|---|---|
| Codegen | Rust/TS round-trip e diff limpo |
| Numeric safety | uint64 > `Number.MAX_SAFE_INTEGER` preservado |
| Canonical JSON | hash idêntico Rust/TS |
| Handshake | matriz major/minor/features/build |
| Identity | stale PID/attempt/fence rejeitado |
| Backpressure | data saturado não bloqueia cancel control |
| Provider | deltas, usage, retry físico, cancel e EOF |
| Capability | allow/ask/deny, dispatch boundary e unknown |
| Artifact | chunk, quota, hash mismatch e resume |
| Terminal | ACK perdido, duplicate igual e conflito |
| Fuzz | framing, unknown fields, oversized payload e invalid enum |

