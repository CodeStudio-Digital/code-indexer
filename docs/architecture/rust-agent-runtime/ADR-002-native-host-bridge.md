# ADR-002 — Bridge Host nativo no mesmo processo e transporte

> **Status:** aceito  
> **Data:** 2026-07-29  
> **Decisão vinculante:** `D-RUST-030`  
> **Complementa:** `D-RUST-027`

## 1. Contexto e evidência

O runner cria os listeners Control/Data dentro do processo contido. O Host só
pode autenticá-lo consultando PID/UID no mesmo HANDLE/FD que carregará o
protocolo. Node/Electron não expõe essa prova como uma capability linear:
receber PID como número, fazer probe seguido de reopen ou usar um sidecar para
relay muda a conexão ou o processo peer e viola `D-RUST-027`.

O Host TS já possui framing, lifecycle e hidratação Data bounded em
`test|shadow`. Faltava uma fronteira nativa que transformasse fatos duráveis em
owners físicos sem duplicar a máquina semântica do agente.

## 2. Decisão

O workspace ganha `agent-host-bridge`, crate de biblioteca com dependências
internas somente em `agent-platform` e `agent-protocol`.

- A única entrada de abertura é o Protobuf gerado
  `HostAttemptBridgeOpenRequest`.
- O request contém launch, `LaunchAccepted`, `AttemptProcessSpawned`,
  `AttemptContainmentReport`, deadline de abertura e containment requerido.
- Antes de qualquer I/O, o core exige igualdade de identity e budget, ordem
  temporal, reservation/resource group/runtime, proveniência, containment,
  seal de ativação válido e conjunto exato Control/Data/Pulse.
- Control e Data são abertos uma vez e cada conexão verifica o PID do runner no
  próprio Named Pipe. Falha do segundo open descarta o primeiro.
- O resultado é um owner Rust único que só transfere channels tipados Control e
  Data. Ele não exporta address, token ou handle cru como prova.
- Bytes do request e seus tokens/nonces são single-use e zerados nos lados TS e
  Rust após settlement.
- Windows é a primeira implementação física. Outros targets permanecem
  fail-closed até possuírem a mesma prova bilateral, incluindo UID no Unix.

O carregamento pelo produto é feito por `agent-host-bridge-napi`, fachada ABI
Node-API 8 in-process fina. Para attempts, ela transporta o request gerado,
invoca `agent-host-bridge` e adapta I/O async bounded; não constrói owner, aceita
PID como autenticação, reabre endpoint ou implementa uma segunda validação
divergente. Control/Data permanecem no mesmo objeto Rust, têm lifecycle de
stream independente e possuem `close()` explícito no owner; Drop/GC é somente
backstop.

A mesma biblioteca dinâmica verificada também exporta a abertura do
`agent-session-bridge`, evitando um segundo addon/ABI no produto. Isso é apenas
composição na borda: `agent-host-bridge` continua sem dependência de storage e
`agent-session-bridge` continua sem dependência de transporte da attempt. A
fachada não transfere owner, root de bundle, endpoint ou handle entre os cores.

## 3. Alternativas rejeitadas

### Sidecar/relay nativo

O Named Pipe passaria a autenticar o sidecar, não o processo Host. Além de
aumentar memória e blast radius, quebra a identidade física exigida.

### `net.Socket` TypeScript com PID informado

O número é dado não autenticado. Mesmo quando o socket funciona, não cria
receipt não-forjável do peer no handle vivo.

### Colocar a lógica em `agent-session-bridge`

Mistura lifecycle de sessão durável com transporte efêmero por attempt e
amplia dependências de um owner que deve permanecer independente.

### Expor handle bruto ao JavaScript

Permite alias, fechamento, reopen e uso depois da transferência. Ownership
linear deixaria de ser verificável.

## 4. Impacto

- Grafo nativo possui 11 crates e 13 arestas internas: a aresta adicional liga
  somente a fachada ABI `agent-host-bridge-napi` ao core independente
  `agent-session-bridge`.
- `supervisor.proto` recebe `HostAttemptBridgeOpenRequest`.
- `packages/agent-runtime-host` produz e consome o request por owner single-use.
- O wrapper Node-API é o terceiro artefato hasheado do pacote Rust, ao lado de
  runner/supervisor, e só é carregado de um `VerifiedRuntimePackage`.
- O coordinator continua interno e `test|shadow` até o E2E process-real
  completar `AgentHello → Prepare/Hydration → Prepared → Activate → Active`.

## 5. Riscos e rollback

- Falha de addon: attempt falha fechado antes de `Prepared`; fallback só segue
  a rota durável já autorizada, nunca acontece dentro da mesma attempt.
- ABI/packaging: Node-API 8, Node 22 e Electron 42.5 possuem package smoke local;
  assinatura/AV e a matriz instalada remota continuam nos gates de supply chain.
- Leak de owner: wrapper deve possuir close/reaper explícito; GC/drop não é
  confirmação de cleanup.
- Plataforma incompleta: target sem peer check bilateral continua indisponível.
- Rollback remove o wrapper e mantém `agent-host-bridge` sem promoção; não
  restaura probe/reopen nem relay.

## 6. Gates afetados

- `G1-HS-01..05`
- `G1-IDL-01..04`
- `G2-BLD-01..06`
- `G6-MIG-01..09`

O core conclui sua fatia com testes de divergência pré-I/O, PID falso e owners
Control/Data reais. O addon conclui sua fatia quando o artefato verificado
carrega em Node/Electron, rejeita request inválido, zera o Buffer de entrada e
expõe cleanup explícito. Promoção ainda exige o E2E Host TS↔runner no mesmo
transporte até `ActiveAuthority`.
