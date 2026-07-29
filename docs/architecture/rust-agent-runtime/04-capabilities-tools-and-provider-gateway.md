# 04 — Capabilities, tools e Provider Gateway

> **Status:** normativo  
> **Requisitos:** `CAP-*`  
> **Owners futuros:** `agent-tools`, Host ToolHost, Provider Gateway

## 1. Modelo de capability

Uma capability é descriptor imutável + executor identificado. Ela não contém
closure, store, callback, runner ou `AbortSignal`.

Descriptor mínimo:

```text
capabilityId
version
name / aliases / displayName
description
source / providerId / metadataTrust
inputSchema / outputSchema
visibility
executionClass
mutates / parallelSafe / repeatPolicy
sideEffectContract
timeoutPolicy
cancellationMode
environment/network/secret requirements
riskClassifierRef
outputPolicyRef
lifecycleRef
enabled
```

### CAP-001

Descriptor e executor são versionados separadamente. O hash do resolved
capability set entra na attempt spec.

### CAP-002

Authorization não faz parte de visibility/tier. Toda invocation passa pelo
Policy Engine.

### CAP-003

Metadata externa é untrusted até sanitização. Description/schema nunca concedem
permissão.

## 2. Classes de execução

| Classe | Executor V1 |
|---|---|
| `native_read` | Rust |
| `native_mutation` | Rust, após gate de policy/fencing |
| `native_process` | Rust + subprocesso contido |
| `host_provider` | TypeScript Provider Gateway |
| `host_capability` | TypeScript ToolHost |
| `control_interactive` | TypeScript control plane |
| `nested_code` | Node/QuickJS descartável |
| `remote_environment` | Adapter explícito |

### CAP-004

O route decision é parte da resolved spec e não muda silenciosamente durante a
attempt. Update exige version/hash novo e mensagem explícita.

## 3. Capability lifecycle

```text
admitted
  -> policy_evaluated
  -> approval_required | rejected_before_accept | accepted
  -> started
  -> succeeded | failed | cancelled | outcome_unknown
```

### CAP-005

`accepted` é a fronteira após a qual timeout/porta fechada não prova que o efeito
não ocorreu.

### CAP-006

Retry automático só é permitido nos stages declarados por
`SideEffectContract.safeRetryStages`.

### CAP-007

Capability com side effect externo e sem idempotency/probe retorna
`outcome_unknown` quando perde ACK depois de accepted.

## 4. Policy e resource binding

Fluxo obrigatório:

1. runner canonicaliza input e calcula hash;
2. host resolve environment/resources;
3. host avalia policy;
4. se `ask`, host persiste interaction/approval;
5. host retorna `SealedExecutionGrant`;
6. executor valida schema/hash/expiry/fence;
7. executor revalida binding imediatamente antes do efeito;
8. executor registra dispatch boundary;
9. executor executa;
10. executor publica terminal.

### CAP-008

Input patch de policy/hook volta ao início da validação e policy. Não é aplicado
diretamente ao executor.

### CAP-009

Grant é preso a:

- tool use;
- capability ID/version;
- effective input hash;
- environment/version;
- workspace lease/version/epoch;
- policy version;
- expiry/nonce.

### CAP-010

Grant stale, desconhecido ou com hash divergente falha fechado.

## 5. Tools nativas de leitura

Primeira família:

- `read_file` por range;
- `stat`/metadata;
- `list_directory`;
- `glob`;
- `grep`/search textual;
- Git status/diff/log/show;
- leitura HTTP permitida.

### CAP-011

Toda leitura:

- opera sobre path canônico;
- valida root/resource binding;
- define política de symlink/junction;
- limita bytes, entradas, profundidade e tempo;
- pode retornar preview + artifact;
- contabiliza bytes lidos e emitidos.

### CAP-012

Search em árvore grande usa streaming/iterator e nunca materializa todos os paths
ou matches sem limite.

### CAP-013

Binary, encoding inválido e arquivo mutável durante leitura têm outcomes
explícitos.

## 6. Tools nativas de mutação

Família:

- create/write file;
- patch/edit;
- mkdir;
- move/rename controlado;
- Git add/commit/branch/merge/rebase conforme policy.

### CAP-014

Mutação requer:

- exclusive or permitted workspace lease;
- precondition/hash/version quando aplicável;
- resource binding atual;
- durable intent boundary;
- resultado com before/after refs;
- classification de partial failure.

### CAP-015

Patch valida integralmente antes de aplicar e falha atomicamente quando o formato
permitir.

### CAP-016

Operação destrutiva exige target resolvido e não aceita root amplo, env var não
resolvida ou glob como autoridade.

### CAP-017

Mutação Git preserva worktree dirty e nunca usa index compartilhado sem lease.

## 7. Processo e shell

### CAP-018

Todo processo filho nasce dentro do resource group da attempt antes de executar
código de usuário.

### CAP-019

Limites obrigatórios:

- wall/CPU time;
- memory/process count;
- output stdout/stderr;
- stdin bytes;
- cwd/environment allowlist;
- open handles;
- child tree.

### CAP-020

Stdout e stderr são drenados concorrentemente até exit. UI/backpressure não
pode bloquear o dreno; bytes excedentes vão para spool ou são truncados conforme
output policy.

### CAP-021

`wait_with_output`/equivalente que coleta output ilimitado é proibido.

### CAP-022

Fire-and-forget é proibido, salvo capability persistente host-owned com lease e
identity próprias.

### CAP-023

Terminal da attempt exige zero subprocessos locais ainda owned. Grace vencida
mata a árvore; capability persistente host-owned possui lease própria e não é
descendente oculto do runner.

## 8. HTTP e network

### CAP-024

HTTP nativo aplica network scopes, DNS/IP revalidation, redirect policy, métodos,
body/response limits e secret handles.

### CAP-025

Redirect não pode escapar da allowlist.

### CAP-026

Response grande é streamado para spool. Compressão não contorna limite
descomprimido.

### CAP-027

Sockets persistentes pertencem a operation/attempt e fecham no cancel/reap.

## 9. Provider Gateway TypeScript

O host mantém:

- OAuth/credentials;
- provider discovery;
- model aliases/capabilities;
- request adapters;
- retry físico;
- reasoning/thinking specifics;
- vision/image fallback;
- cache/usage metadata.

O Rust mantém:

- composição do contexto;
- request logical ID;
- budget;
- consumo do stream;
- tool loop;
- fallback policy lógica após terminal tipado.

### CAP-028

Gateway é stateless por request além de registry bounded de operations ativas.

### CAP-029

Gateway não mantém transcript ou segunda resposta completa.

### CAP-030

Runner death/fence cancela provider por operation ID. Cancelamento best-effort
sem fechamento de authority é insuficiente.

### CAP-031

Retry físico é reportado quando conhecido; provider-managed retry é marcado
como unknown, nunca inventado.

### CAP-032

Usage/cache só é afirmado a partir do provider response.

## 10. Host capabilities

Permanecem no ToolHost inicialmente:

- MCP interno/externo;
- plugins;
- browser/Chrome/computer use;
- preview/dev server;
- LSP;
- docs/index/memory;
- DB/admin/app integrations;
- Company/App Studio;
- recursos persistentes de sessão.

### CAP-033

Cada host operation tem registry bounded com:

- attempt/fence;
- operation/tool IDs;
- accepted/started stage;
- cancellation handle;
- deadline;
- side-effect contract;
- terminal/probe.

### CAP-034

ToolHost não recebe runner, callback, class instance ou `AbortSignal` pelo wire.

### CAP-035

MCP/plugin metadata é sanitizada e policy é aplicada no host. Rust não confia em
flags vindas do servidor externo.

### CAP-036

Recurso persistente que sobreviva à attempt precisa de owner/lease próprios.

## 11. `code_exec`

### CAP-037

`code_exec` nunca embute V8/QuickJS no runner ou supervisor.

### CAP-038

Cada execução usa processo descartável dentro do resource group, sem DB,
credential ou filesystem implícito.

### CAP-039

O ambiente expõe somente proxy de capabilities. Chamada nested percorre:

- schema;
- task/goal scope;
- policy;
- approval;
- resource binding;
- fencing;
- operation ledger;
- output pipeline.

### CAP-040

Budgets mínimos:

- JS CPU e wall time;
- calls e parallel calls;
- input/output bytes;
- child processes;
- spool;
- nested depth.

### CAP-041

Estado de VM não entra em checkpoint. Resume reinicia o código a partir de
estado declarativo/artifacts, nunca de heap.

## 12. Output contract

`CapabilityTerminal` retorna:

```text
sideEffectOutcome
success | typedError
displayPreview
structuredResultRef
artifactRefs
truncation
usage
duration
retryability
```

### CAP-042

Preview possui limites de bytes e caracteres. Conteúdo integral grande é
artifact.

### CAP-043

Path físico de spool não aparece para modelo/UI; apenas refs autorizadas.

### CAP-044

Erro grande também é artifact; stack/redaction seguem policy.

## 13. Tool catalog e atualização

### CAP-045

Catálogo completo existe uma vez no host. Runner recebe somente resolved
capability set necessário à attempt.

### CAP-046

Snapshot é imutável durante a attempt. Capability desativada por segurança pode
ser fenced/cancelada por update explícito.

### CAP-047

Rust/TS calculam hash idêntico do descriptor canônico.

## 14. Ambientes remotos

### CAP-048

`environmentId + environmentVersion` da resolved spec define onde a capability
executa. Um environment remoto nunca cai silenciosamente para o filesystem ou
shell local.

### CAP-049

Na V1, environment remoto PODE usar adapter host-owned. Ele continua passando
por `CapabilityPrepare`, policy, binding, accepted/started/terminal, quotas,
artifact pipeline e cancelamento por operation ID.

### CAP-050

Se `agentd` for instalado no host remoto, ele mantém a mesma fronteira: um
processo/resource group por attempt, protocolo autenticado, payload bounded e
nenhuma credencial do SQLite central. Transporte de rede exige autenticação
mútua e proteção contra replay; Named Pipe/Unix socket local não é reutilizado
como se fosse seguro remotamente.

### CAP-051

Partição de rede depois de `started` em capability mutante produz
`outcome_unknown` até probe/reconciliação. Reconectar não autoriza repetir a
intenção.

### CAP-052

Upload/download remoto usa chunks com crédito, hash e quota. Resultados grandes
viram `ArtifactRef`; nenhum adapter acumula corpo integral para então copiá-lo
ao runner.

## 15. Verificação obrigatória

| Área | Prova |
|---|---|
| Descriptor | Golden hash Rust/TS |
| Policy | allow/ask/deny e patch re-evaluation |
| Fence | lease muda imediatamente antes do efeito |
| Read | huge tree, binary, symlink/junction e byte caps |
| Mutation | precondition, partial failure e rollback permitido |
| Process | fork bomb, stdout flood, hang e descendant cleanup |
| HTTP | redirects, decompression bomb, DNS/IP e cancel |
| Provider | cancel após runner death, usage e retries |
| Host Tool | timeout/port loss e `outcome_unknown` |
| `code_exec` | nested parity, limits, kill e zero VM state |
| Output | preview/artifact/truncation e privacy |
| Remote | partição, stale environment, chunk resume e unknown pós-dispatch |
