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

Cada tentativa raiz DEVE possuir processo e resource group exclusivos. Duas
sessões não podem compartilhar heap mutável ou fault domain.

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
- Portar Electron, dashboard, Hono ou stores para Rust.
- Permitir que Rust escreva diretamente no SQLite central na primeira versão.
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
| Run-tree | Root attempt, subagentes e subprocessos sob um orçamento agregado |
| Supervisor | Processo Rust permanente que admite, lança, monitora e mata runners |
| Runner | Processo Rust single-tenant que executa uma attempt |
| Host | Backend TypeScript que possui DB, providers, plugins e integrações |
| Provider Gateway | API host-owned para request/stream/cancelamento de provider |
| ToolHost | API host-owned para capabilities ainda não nativas |
| Resource group | Job Object, cgroup ou mecanismo equivalente por run-tree |
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
- **Fallback permitido:** processo por sessão com recycle obrigatório, somente
  se benchmark packaged provar que o modelo por attempt viola o gate de TTFT.

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

- command ledger, AgentRun store, attempts, leases e journal;
- Policy Engine, approvals e grants;
- Environment Broker e Workspace Lease;
- Provider Gateway;
- plugins, MCP, browser, preview, LSP, docs, memória, Company e App Studio;
- projeções SSE/WebSocket e dashboard.

### D-RUST-007 — Um único escritor do SQLite

Rust NÃO DEVE abrir o SQLite central. Persistência ocorre por RPC idempotente ao
host. Spool local tem store próprio e não compartilha transações com o DB
central.

### D-RUST-008 — Provider permanece no host na V1

O runner compõe a request normalizada e recebe um stream bounded. O host possui
credenciais, OAuth, discovery, retry específico e fallbacks. O gateway NÃO
DEVE acumular uma segunda resposta completa.

### D-RUST-009 — `code_exec` é processo descartável

O runner coordena `code_exec`, mas JavaScript executa fora do runner e do
supervisor. O processo fica no resource group do run, com timeout, memória,
process count, output e disco limitados.

### D-RUST-010 — Protobuf é a autoridade cross-language

O `.proto` versionado substitui types TypeScript como wire authority. O pacote
TypeScript atual continua como domínio/adapters até a convergência.

### D-RUST-011 — Terminal exige barreira durável

O runner propõe terminal, mas só encerra como confirmado após ACK do host. Se o
ACK for perdido após possível efeito, o estado é reconciliado por IDs/hash;
mutação nunca é repetida automaticamente.

### D-RUST-012 — Legado é oracle temporário

O runtime TypeScript PODE ser usado para:

- gerar fixtures e golden traces;
- comparação shadow;
- fallback de cohort não migrado;
- rollback durante rollout.

Ele NÃO DEVE receber novos conceitos de arquitetura para se aproximar do Rust.

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
| Session/command/run/attempt | Host | Autoridade persistida |
| Lease/fencing | Host | Runner mantém snapshot e revalida |
| Processo/resource group | Supervisor | Único owner dos handles de kill |
| Loop/hot context | Runner | Destruído ao fim da attempt |
| Provider credentials/client | Host | Nunca serializado para runner |
| Capability descriptor snapshot | Host → runner | Imutável e hashado |
| Policy decision/grant | Host | Binding selado, curto e versionado |
| Native tool execution | Runner/child | Sob resource binding |
| Host capability execution | ToolHost | Cancelável e fenced |
| SQLite central | Host | Escritor único |
| Spool bytes | Spool service | Quota, hash e ACL por sessão |
| Journal | Host | Source durável de lifecycle |
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

- `native/agent-runtime` DEVE ser um Cargo workspace.
- A versão mínima de Rust DEVE ser pinada em `rust-toolchain.toml`.
- O lockfile DEVE ser versionado.
- A policy de crates e auditoria de supply chain DEVE ser definida.
- Builds Windows x64/arm64, macOS x64/arm64 e Linux x64/arm64 DEVEM existir.
- Binaries DEVEM ser assinados e empacotados pelo pipeline do Electron.
- O host DEVE possuir feature flag de cohort.
- O runtime Rust NÃO DEVE importar `packages/code-agent`.

## 10. Gate deste documento

Antes de iniciar implementação funcional:

- todas as decisões D-RUST devem estar aceitas;
- o layout deve estar confirmado;
- a unidade `AgentRunAttempt` deve estar refletida no IDL;
- ownership de DB, provider, policy, spool e processo deve ter exatamente um
  owner;
- qualquer exceção deve existir como ADR no mesmo diretório.
