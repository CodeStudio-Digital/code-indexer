# 03 — Engine, contexto e subagentes

> **Status:** normativo  
> **Requisitos:** `ENG-*`  
> **Owner futuro:** `agent-engine`

## 1. Arquitetura interna

O engine é independente de transporte, plataforma e provider concreto.

```text
AgentEngine
  RunState
  TurnLoop
  ContextManager
  BudgetTracker
  CompactionPlanner
  CapabilityRouterPort
  ProviderGatewayPort
  ChildRunPort
  InteractionPort
  CheckpointPort
  EventSink
```

### ENG-001

Nenhum módulo do engine importa Electron, Node, SQLite, MCP SDK ou bindings de
SO.

### ENG-002

Todos os ports são async, canceláveis, bounded e identificados por operation.

### ENG-003

Não existe `ToolContext` genérico com stores/callbacks/runner. O engine recebe
interfaces estreitas e serializáveis.

## 2. Estado em memória

`RunState` PODE manter:

- identity e spec imutável;
- budget corrente;
- hot transcript window;
- referências de capítulos frios;
- provider/tool/child operations ativas;
- pending interaction IDs;
- compactação pendente;
- último checkpoint confirmado;
- counters e hashes.

`RunState` NÃO DEVE manter:

- transcript completo sem limite;
- output integral já promovido a artifact;
- credenciais/provider clients;
- lista ilimitada de eventos;
- catálogo global duplicado;
- process handles fora do port;
- referências cíclicas fortes entre engine/tasks.

### ENG-004

Toda coleção cresce sob limite por count e bytes. Limite por count sozinho não
é suficiente.

## 3. State machine lógica

```text
created
  -> hydrating
  -> ready
  -> composing
  -> provider_stream
  -> capability_dispatch | composing | compacting
  -> waiting | stopping | terminalizing
  -> terminal
```

Subestados podem repetir, mas transições são validadas.

### ENG-005

O único caminho de sucesso é `terminalizing -> completed`.

### ENG-006

Erro de protocolo, output inválido, budget, cancel e authority loss possuem
classificação explícita; não caem em sucesso por EOF.

## 4. Algoritmo de turno

Cada turno segue:

1. verificar authority, deadline e budget;
2. hidratar refs necessárias sob quota;
3. compor system/user/tool context;
4. resolver capability summary da spec;
5. iniciar provider operation;
6. consumir stream com backpressure;
7. persistir/coalescer deltas;
8. montar tool calls completas;
9. preparar policy/binding por tool;
10. executar tools permitidas;
11. inserir resultados limitados no contexto;
12. compactar quando necessário;
13. decidir próximo provider turn, wait ou terminal;
14. criar checkpoint em barreiras definidas.

### ENG-007

Authority e deadline são revalidados antes dos passos 5, 9, 10, 13 e 14.

### ENG-008

Provider/tool result inválido não é inserido como mensagem livre. Ele recebe
erro tipado, truncation metadata e artifact ref quando aplicável.

### ENG-009

Tool call e tool result mantêm pairing por `toolUseId`. Transcript órfão falha
em validação ou é reparado por regra explícita antes do provider.

## 5. Provider stream

### ENG-010

O engine nunca interpreta EOF como `done`.

### ENG-011

Deltas adjacentes compatíveis PODEM ser coalescidos. Tool boundary, identidade,
thinking/text transition e terminal forçam flush.

### ENG-012

O engine mantém somente:

- conteúdo necessário à mensagem corrente sob limite;
- preview recente;
- offsets/hashes do spool.

O stream integral não fica duplicado em `String`, IPC e transcript.

### ENG-013

Usage, response ID, physical attempt e cache metadata são eventos próprios, não
campos inferidos do texto.

### ENG-014

Provider fallback cria attempt nova quando a policy de recovery exigir nova
execução física. Não reusa operação ou fence antiga.

## 6. Context manager

O contexto tem camadas:

1. system/policy/preset;
2. task e instruções;
3. hot transcript;
4. summaries/checkpoint;
5. memory/index refs recuperados;
6. tool descriptors visíveis;
7. artifacts explicitamente hidratados.

### ENG-015

Cada camada declara bytes, tokens estimados, origem, hash e prioridade.

### ENG-016

O budget planner rejeita composição acima do limite antes de iniciar provider.

### ENG-017

Tool descriptors são referenciados por capability snapshot. O engine não cria
closures nem wrappers por subagente.

### ENG-018

Conteúdo derivável de repo/index não é copiado automaticamente para memória
durável.

## 7. Hot transcript e capítulos frios

### ENG-019

`maxHotTranscriptBytes` e budget de tokens são limites duros.

### ENG-020

Quando a janela excede o limite:

1. selecionar prefixo fechando tool pairs;
2. gerar summary/checkpoint;
3. persistir capítulo como artifact;
4. verificar hash/ACK;
5. substituir prefixo por ref + summary;
6. atualizar counters.

### ENG-021

Compactação nunca remove:

- mensagem de usuário ainda não resolvida;
- tool call sem result;
- interaction pendente;
- policy/grant necessário a operação ativa;
- terminal ainda não confirmado.

### ENG-022

Falha de compactação não autoriza descartar contexto. O run interrompe ou tenta
estratégia explicitamente configurada.

## 8. Checkpoints

Checkpoint contém:

- schema/engine build;
- identity/spec hashes;
- provider/model/preset binding;
- budget consumido;
- hot transcript e chapter refs;
- capability/environment/policy refs;
- workspace lease snapshot;
- child graph e outcomes;
- pending interactions;
- operation ledger e side-effect stages;
- last event/stream sequences;
- output/result refs;
- checksum.

### ENG-023

Checkpoint não contém secret, process handle, socket, provider client ou VM.

### ENG-024

Somente checkpoint confirmado pelo host pode ser usado em recovery.

### ENG-025

Recovery revalida versões, artifacts, workspace lease e policy. Snapshot stale
não herda authority.

## 9. Budgets

O engine aplica:

- turns;
- wall time;
- input/output tokens;
- tool calls;
- agents/depth/waves;
- cost micros;
- context/hot bytes;
- concurrent operations.

### ENG-026

Budget delegado a child é reservado antes do spawn e reconciliado no terminal.

### ENG-027

Budget esgotado terminaliza como `interrupted`, não `completed`.

### ENG-028

Budget monetário usa micros/decimal e usage comprovada. Estimativa é identificada
como estimativa.

## 10. Interações e approvals

Tipos mínimos:

```text
question
plan_approval
spec_approval
tool_approval
budget_request
conflict_resolution
outcome_unknown_reconciliation
```

### ENG-029

Cada interação possui ID, schema de resposta, deadline e idempotency key.

### ENG-030

Resposta é aceita pelo host, vinculada à interaction e entregue à attempt
corrente. Attempt antiga não consome resposta.

### ENG-031

Espera longa checkpointa e libera processo. Interaction resolvida cria resume.

### ENG-032

Headless/UI sem suporte tem timeout e outcome definido; nunca espera para sempre.

## 11. Subagentes

### ENG-033

Todo subagente de produto é child `AgentRun` persistido, com attempt/processo,
budget e capability profile próprios.

### ENG-034

Spawn segue:

1. engine reserva budget lógico;
2. envia `SpawnChildRun`;
3. host valida policy/admission;
4. host cria child run/attempt;
5. supervisor lança runner;
6. pai recebe `ChildRunAccepted`;
7. updates chegam bounded;
8. terminal entrega result/transcript refs.

### ENG-035

Pai não recebe `Vec<Message>` do filho. Recebe:

- status;
- summary limitado;
- result/artifact refs;
- usage;
- claims/evidence refs;
- terminal reason.

### ENG-036

Fan-out é limitado por `maxAgents`, `maxDepth`, `maxWaves`, memória reservada e
concorrência global.

### ENG-037

Cancelamento propaga root → descendants. Child detached só sobrevive se o host
persistir transferência explícita de owner e budget.

### ENG-038

Completed child nunca é relançado por recovery. Running sem prova é reconciliado
ou `outcome_unknown`.

## 12. Foreground e background

### ENG-039

O executor é o mesmo. Foreground espera terminal; background retorna identity e
continua sob supervisor/control plane.

### ENG-040

Background não significa processo sem owner. Heartbeat, deadline, lease,
checkpoint e reaper permanecem obrigatórios.

### ENG-041

Resultado background não coletado permanece artifact durável sob TTL/quota; não
fica como string ilimitada no supervisor/runner pai.

## 13. Ultra e presets

Ultra continua composição ortogonal:

- reasoning;
- orchestration;
- parallelism;
- depth;
- verification;
- background;
- durability;
- isolation;
- budget.

### ENG-042

O engine recebe preset já resolvido. Downgrades vêm explícitos do host.

### ENG-043

Ultra não libera budgets nem policy por implicação.

## 14. Determinismo e replay

O replay shadow não exige texto idêntico do modelo. Compara:

- sequence de lifecycle;
- provider/tool boundaries;
- policy decisions;
- tool pairing;
- budget accounting;
- child topology;
- checkpoint hashes;
- terminal classification.

### ENG-044

Fixtures gravadas removem secrets e têm versão de provider/contract.

### ENG-045

Engine possui provider/tool fakes determinísticos para state-machine tests.

## 15. Shutdown

### ENG-046

Shutdown cooperativo:

1. bloquear novas operations;
2. cancelar provider/tools/children;
3. flush critical events;
4. tentar checkpoint;
5. propor terminal;
6. aguardar ACK;
7. fechar task group.

### ENG-047

Se grace expirar, supervisor mata o resource group. Engine não mascara hard kill
como sucesso.

## 16. Verificação obrigatória

| Área | Prova |
|---|---|
| State machine | Property tests de todas as transições |
| Context | Byte/token limits e tool pairing |
| Provider | EOF, delta, error, retry/fallback e backpressure |
| Compaction | Crash em cada etapa e último checkpoint íntegro |
| Budgets | Boundary exata e delegação child |
| Interactions | wait/checkpoint/resume e resposta stale |
| Subagentes | fan-out/fan-in, crash, detach, cancel e recovery |
| Terminal | somente um terminal e barrier ordering |
| Leak lógico | task/channel/collection counters retornam a zero |

