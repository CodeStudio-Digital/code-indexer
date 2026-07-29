# 05 — Durabilidade, eventos, spool e observabilidade

> **Status:** normativo  
> **Requisitos:** `DUR-*`, `OBS-*`, `SEC-*`  
> **Owners futuros:** `agent-session-store`, Host control plane, `agent-spool`,
> telemetry

## 1. Autoridades

| Estado | Authority |
|---|---|
| Decisão command/run/attempt/lease/fence | Host control plane |
| Commit command/run/attempt/lease/fence | Rust session store |
| Lifecycle journal/global sequence | Rust session store, no bundle UUID |
| Process/Job/pipes | Supervisor |
| Hot context | Runner |
| Scratch/spool temporário | Spool da attempt |
| Artifact/checkpoint durável | Rust session store |
| Provider operation | Host Provider Gateway |
| Host capability operation | ToolHost |
| UI/SSE/WebSocket | Projeção sem authority |

### DUR-001

Somente `agent-session-store` abre um bundle `rust_fs_v1`. Rust nunca abre o
SQLite central; runner, supervisor, `code_exec` e Host TypeScript nunca abrem
arquivos mutáveis do bundle. Snapshots necessários chegam por protocolo ou
artifact ref.

### DUR-002

O Rust session store é o único emissor de `globalSeq`, `recordedAt` físico e
hash do journal. O Host fornece actor, decisão semântica e redaction policy; o
store valida generation, lease epoch, fence, idempotency key e limites antes do
commit.

## 2. Camadas de storage

```text
attempt scratch
  -> temporary spool
  -> Rust session bundle
```

### Scratch

- owner: attempt;
- removido no reap;
- não retomável;
- sem paths expostos ao modelo.

### Temporary spool

- quotas por artifact/attempt/session/global;
- content hash;
- manifesto privado;
- pode sobreviver a crash por grace limitada;
- só vira durável após promoção.

### Durable artifact store

- owner/session ACL;
- ref persistida no bundle pelo Rust session store;
- retention e GC;
- leitura por handle autorizado.

## 3. Artifact manifest

Campos mínimos:

```text
artifactId
kind
ownerSessionId
ownerAgentRunId
ownerAttemptId
contentSha256
mediaType
byteLength
storedLength
compression
privacyClass
redactionPolicyVersion
createdAt
retentionClass
sourceOperationId
```

### DUR-003

`artifactId` aleatório é a capability de acesso; SHA-256 não é authorization.

### DUR-004

Escrita local segue:

1. arquivo temporário no root da attempt;
2. streaming com byte quota;
3. flush/fsync conforme durability class;
4. hash e tamanho verificados;
5. rename atômico;
6. manifesto confirmado;
7. proposta de promoção;
8. commit no Rust session store;
9. receipt durável ao Host/runner.

### DUR-005

Artifact acima da quota aborta a operation antes de consumir disco ilimitado.

### DUR-006

GC remove somente artifact sem refs após grace. Hash igual não autoriza
cross-session dedup visível.

## 4. Checkpoint

Checkpoint é artifact privado, versionado e hashado.

### DUR-007

O checkpoint contém refs, não cópias de outputs grandes.

### DUR-008

Checkpoint inclui:

- engine/protocol/schema versions;
- identity/spec/catalog/environment/policy hashes;
- budget/usage;
- hot transcript;
- cold chapter refs;
- child run graph;
- operation ledger e side-effect stages;
- pending interactions;
- provider/model/preset binding;
- workspace lease snapshot;
- last local/global event cursors conhecidos;
- result/transcript refs;
- checksum.

### DUR-009

Checkpoint não contém:

- secret material;
- credentials/tokens;
- raw environment secrets;
- process/socket/file handles;
- VM state;
- provider client;
- absolute spool path.

### DUR-010

O Host valida a decisão semântica; o Rust session store valida bytes, schema
version, generation, fence, refs e hash antes de confirmar checkpoint.

### DUR-011

Somente `CheckpointCommitted` atualiza `AgentRun.checkpointRef`.

## 5. Terminal barrier

### DUR-012

Antes de `TerminalCommitted`, devem estar confirmados:

- critical event sequence até `lastEventSeq`;
- transcript ref;
- checkpoint/result refs aplicáveis;
- terminal usage/budget;
- child outcomes necessários;
- side-effect unknowns;
- terminal da attempt e do seu `AgentRun`;
- terminal do root `SessionCommand` somente quando o run é root e sua
  completion policy confirma children/verifier obrigatórios.

### DUR-013

O runner pode reenviar proposal idêntico. Terminal diferente para a mesma
attempt é conflito.

### DUR-014

O processo só sai normalmente depois do commit. Hard kill antes disso gera
recovery a partir do último checkpoint, não sucesso presumido.

## 6. Journal

Preservar classes semânticas existentes:

| Classe | Conteúdo | Durabilidade |
|---|---|---|
| A | command/control/approval | síncrona/autoritativa |
| B | side-effect boundaries | autoritativa |
| C | lifecycle/checkpoint/terminal | autoritativa |
| D | progress operacional relevante | bounded/durável conforme tipo |
| E | texto/thinking reconstruível | coalescido/projetável |
| F | diagnóstico | redigido, amostrado, droppable |

### DUR-015

Classes A–C não podem ser descartadas ou reordenadas.

### DUR-016

Runner emite local sequence; Host valida a decisão/fence e o Rust session store
deduplica e atribui global sequence no commit.

### DUR-017

Payload hash e idempotency key detectam replay divergente.

### DUR-018

Journal não persiste prompt, transcript, base64 ou tool payload bruto por
default. Usa refs e metadata mínima.

## 7. Streaming e projeções

### DUR-019

SSE/WebSocket é projeção. Disconnect não cancela run.

### DUR-020

Slow consumer é desconectado quando ultrapassa fila; o executor continua e o
cliente retoma por cursor.

### DUR-021

Live tail preserva fronteiras desde o último durable message boundary. Cap não
remove prefixo ainda não reconstruível.

### DUR-022

Heartbeat atualiza liveness, mas não entra em transcript/cursor semântico.

### DUR-023

Terminal só é projetado após durable barrier.

## 8. Recovery

### Cenário R1 — Crash antes de provider/tool dispatch

- fence attempt;
- registrar crash;
- criar `worker_recovery`;
- retomar último checkpoint;
- operation não iniciada pode ser reexecutada.

### Cenário R2 — Crash depois de capability accepted/started

- fence;
- probe quando disponível;
- resultado comprovado é reconciliado;
- sem prova: `outcome_unknown`;
- não repetir automaticamente.

### Cenário R3 — Crash depois de checkpoint bytes e antes do ACK

- artifact órfão permanece temporário;
- somente checkpoint previamente confirmado é authority;
- GC posterior remove órfão.

### Cenário R4 — ACK terminal perdido

- runner/Host reenvia o mesmo proposal;
- Rust session store retorna o receipt existente;
- payload divergente é conflito.

### Cenário R5 — Supervisor crash

- handles `KILL_ON_JOB_CLOSE`/equivalente encerram run-trees;
- host detecta pipe/parent loss;
- attempts são fenced;
- recovery é decidido pelo control plane a partir do journal consultado no
  Rust session store.

### DUR-024

Cada cenário deve possuir crash injection em toda fronteira durável.

## 9. Observabilidade por attempt

### Lifecycle

- admission wait;
- spawn/handshake/hydrate/activate;
- phase/dwell;
- heartbeat/progress age;
- cancel/fence/grace;
- exit/reap cause.

### Recursos

- RSS/private working set/commit;
- allocator allocated/active/resident quando disponível;
- CPU time;
- thread/handle/process count;
- resource group budget/peak;
- scratch/spool bytes.

### Engine

- hot context bytes/tokens;
- cold chapter count;
- compactions;
- turns/tools/children;
- budget remaining;
- task/channel counts e high-water marks.

### IPC

- frames/bytes por canal;
- in-flight/current/HWM;
- ACK lag;
- coalesced/spooled/dropped counts;
- protocol errors.

### Provider/tools

- operation latency;
- first delta/TTFT;
- usage/cache metadata;
- accepted/started/terminal counts;
- cancellation latency;
- `outcome_unknown`;
- artifacts/truncation.

### OBS-001

Métricas agregadas não usam session/run IDs como labels de alta cardinalidade.
IDs completos pertencem a traces/logs consultáveis.

### OBS-002

Toda métrica de memória identifica unidade e origem: RSS, private, commit, heap,
allocator ou artifact bytes.

### OBS-003

Supervisor reporta processos conhecidos e diferença não atribuída.

### OBS-004

Exit cause usa evidência combinada, não somente exit code.

## 10. Trace context

Todo span/event suporta:

```text
correlationId
sessionId
commandId
agentRunId
attemptId
rootAgentRunId
operationId
toolUseId
providerRequestId
resourceGroupId
```

### OBS-005

Trace context cruza host, supervisor, runner, provider e ToolHost.

### OBS-006

Prompts, secrets e tool payloads não entram em atributos por default.

## 11. Dashboards operacionais

Painéis mínimos:

1. supervisor health e restart loop;
2. active attempts e budgets;
3. memory/commit por run-tree;
4. orphan/process/handle counts;
5. IPC backpressure;
6. provider/tool operations;
7. checkpoint/spool/GC;
8. terminals por cause;
9. Rust versus legacy canary comparison;
10. containment capability por plataforma.

### OBS-007

Cada painel possui link para trace e versão de build/protocol.

### OBS-008

Uso, custo, lifecycle e recursos duráveis são gravados como rollups/segmentos
bounded sob `metrics/`. Samples de alta frequência são coalescidos e rotacionam
por quota/tempo; pulse efêmero não é persistido.

## 12. Privacidade e secrets

### SEC-001

Credenciais reutilizáveis de provider, tool, banco e integração atravessam
somente como handle + scope + expiry. Seu valor não entra em protobuf, argv,
env persistido, logs, artifacts ou dumps.

Nonce e connection/session token efêmeros são material de autenticação do
próprio transporte, não credenciais de aplicação. O
`management_session_token` PODE ser entregue pela autoridade de bootstrap
protegida pelo SO e ecoado no primeiro `HostSupervisorHello` após peer check
físico. Tokens de attempts PODEM existir somente no management já estabelecido
e no handoff protegido single-use ao processo. Todos são proibidos em
argv/env/log/artifact/dump, possuem limite/deadline e são zerados em sucesso,
reject, erro, replay e drop.

### SEC-002

Quando environment injection for inevitável, o broker cria processo diretamente
e não revela o valor ao runner.

### SEC-003

Spool e endpoints usam ACL do usuário/app; arquivos não são world-readable.
Named Pipe restringe logon SID/remote/instância e verifica PID nos dois lados;
UDS usa root e leaf `0700`, socket `0600`, peer PID/UID bilateral e cleanup
descriptor-relative, ou prova equivalente, contra replace concorrente.

### SEC-004

Crash dump é opt-in, protegido, redigido e possui retention curta.

### SEC-005

Artifact promotion valida containment, tamanho, hash, owner e media policy.

### SEC-006

Nenhum path relativo pode escapar do root por traversal, symlink, junction,
mount ou race sem revalidation no ponto do efeito.

## 13. Retenção

Classes mínimas:

| Classe | Exemplo | Retenção |
|---|---|---|
| scratch | temp de tool | até reap |
| transient | spool não promovido | grace curta |
| session | transcript/checkpoint | política da sessão |
| durable | artifact do usuário | política explícita |
| diagnostic | logs/traces | quota/rotação |

### DUR-025

Quota excedida produz evento e outcome definido; nunca crescimento silencioso.

### DUR-026

GC é idempotente, observável e não roda no hot path do terminal.

### DUR-027

Cada bundle persiste `storageGeneration` no manifesto imutável e cada
`leaseEpoch + writerId` no authority log append-only/hash-chained. Todo record
e receipt liga novamente esses três campos. Commit com generation, epoch ou
writer diferente falha fechado antes de tocar journal, payload ou projeção.

### DUR-028

Transferir `typescript_fs_v1 → rust_fs_v1` exige admission fechada, drain de
commits, verificação completa, avanço atômico do epoch e activation receipt.
Depois da ativação não existe fallback para writer TypeScript.

### DUR-029

Todo commit Rust retorna receipt ligado a session, generation, epoch,
operation, global sequence, previous/current hash e durability class. Receipt
não correspondente não autoriza ACK, terminal, projection cursor ou eviction.

### DUR-030

Writer queue, records, bytes, arquivos abertos, sessões ativas, segmentos de
métricas e retention possuem limites simultâneos. Limite excedido produz
outcome tipado e não degrada para escrita não durável.

### DUR-031

Backup, restore, archive, trash, import e export são operações Rust
idempotentes, symlink/junction-safe e verificadas por manifest/hash antes de
publicar uma nova generation.

## 14. Verificação obrigatória

| Área | Prova |
|---|---|
| Artifact | atomic write, hash, quota, ACL e GC |
| Checkpoint | crash em todas as barreiras |
| Terminal | ordering, duplicate e ACK perdido |
| Journal | dedup, sequence, redaction e replay |
| Streaming | slow consumer, reconnect e live tail |
| Recovery | R1–R5 em chaos suite |
| Memory | attribution e retorno à baseline |
| Privacy | secret scanner em frames/logs/artifacts/dumps |
| Observability | trace completo por attempt e child |
| Storage transfer | single writer, generation/epoch, crash e rollback pré-activation |
| Metrics | coalescing, rotação, quotas e recovery de segmento |
