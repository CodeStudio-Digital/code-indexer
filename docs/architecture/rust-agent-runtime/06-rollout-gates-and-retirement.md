# Rollout, gates e aposentadoria do runtime legado

> **Status:** normativo  
> **Escopo:** sequência de entrega, evidências, canário, rollback e retirada  
> **Checklist executiva:** [IMPLEMENTATION-CHECKLIST.md](./IMPLEMENTATION-CHECKLIST.md)

## 1. Princípio de migração

O programa entrega um runtime novo. Ele não contém uma trilha paralela de
hardening arquitetural do `code-agent` atual.

A migração detalhada de cada superfície e a ordem de limpeza são vinculadas por
[08-surface-migration-and-post-cutover-cleanup.md](./08-surface-migration-and-post-cutover-cleanup.md).

O runtime legado PODE ser:

- observado para formar uma baseline;
- executado como oracle de compatibilidade;
- usado como fallback para novas tentativas ainda não elegíveis;
- adaptado nas fronteiras indispensáveis de host, IDL, telemetria, roteamento e
  cutover;
- removido depois da promoção.

O runtime legado NÃO DEVE receber reestruturação de pool, watchdog, tool
registry, transcript, subagentes ou lifecycle como pré-requisito deste
programa. Um defeito no legado só bloqueia o programa se impedir medir a
baseline, comparar o contrato ou operar o fallback com segurança. A solução
preferida é isolar a comparação ou reduzir a superfície do fallback.

## 2. Regras transversais de gate

- **MIG-001 — Evidência antes de promoção.** Nenhuma fase é concluída apenas
  porque o código foi mesclado. Testes, artefatos e medições exigidos precisam
  estar ligados ao item correspondente do checklist.
- **MIG-002 — Build representativa.** Gates de processo, memória, startup e
  packaging usam build empacotada de release. Resultados de `cargo run`, HMR ou
  debugger são diagnósticos, não evidência de promoção.
- **MIG-003 — Ambiente identificado.** Todo benchmark registra commit, build,
  SO, CPU, RAM, filesystem, versão do Electron/Node/Rust, provider, modelo,
  corpus, warm-up e ferramentas de medição.
- **MIG-004 — Amostras comparáveis.** Comparações Rust versus legado usam a
  mesma tarefa, workspace, provider/model, cache state, tools permitidas e
  condição térmica.
- **MIG-005 — Separação de latência.** O relatório separa spawn, handshake,
  hidratação, espera de provider e primeiro delta. TTFT agregado não pode
  esconder regressão local com variância de rede.
- **MIG-006 — Memória comparável.** No Windows, a métrica primária é private
  committed bytes por árvore de Job; no Linux, PSS/cgroup current; no macOS,
  footprint privado aproximado mais RSS da árvore. RSS bruto pode ser exibido,
  mas não é a única base de decisão.
- **MIG-007 — Sem dupla mutação.** Shadow nunca executa duas vezes uma
  capability mutante. Mutação é replay de trace com executor falso ou execução
  exclusiva no runtime selecionado.
- **MIG-008 — Tentativa indivisível.** Um `AgentRunAttempt` pertence a um único
  runtime do início ao terminal. Fallback e rollback só selecionam novas
  tentativas.
- **MIG-009 — Stop condition vence agenda.** A presença de qualquer stop
  condition aberta impede aumentar o canário, mesmo que médias agregadas
  permaneçam dentro do alvo.
- **MIG-010 — Sem waiver silencioso.** Exceção a um MUST exige ADR, risco
  associado, owner, prazo e aprovação explícita. O checklist aponta a ADR.

## 3. Matriz de gates quantitativos

Os alvos abaixo são mínimos de promoção. Um relatório pode adotar limite mais
estrito sem alterar o spec.

| ID | Medição | Gate |
|---|---|---|
| `GATE-MEM-01` | Supervisor após warm-up, sem attempts | private/PSS menor ou igual a 40 MiB |
| `GATE-MEM-02` | Runner representativo em estado estável, excluindo artifacts promovidos e page cache compartilhado | incremento privado menor ou igual a 64 MiB |
| `GATE-MEM-03` | Root com oito filhos versus root-only, contra a mesma baseline ociosa | incremento total menor que 3 vezes o cenário root-only |
| `GATE-MEM-04` | 500 attempts sequenciais concluídos e reaped | supervisor volta a `baseline + max(10 MiB, 10%)` |
| `GATE-MEM-05` | Soak de churn por 6 h depois do warm-up | inclinação robusta menor que 1 MiB/h no supervisor e host |
| `GATE-MEM-06` | Attempt representativa ativa por 6 h depois de estabilizar hot window | inclinação privada menor que 1 MiB/h, nenhum contador/queue cresce sem limite e todos os caps permanecem respeitados |
| `GATE-ISO-01` | Memory bomb dentro de uma attempt com outra em paralelo | somente a attempt alvo é eliminada; a paralela conclui |
| `GATE-LIFE-01` | 1.000 ciclos start/cancel/resume/crash durante 24 h | zero PIDs, Jobs, process groups, pipes, handles e scratch dirs órfãos |
| `GATE-LIFE-02` | Cancelamento cooperativo | ACK p95 menor ou igual a 250 ms |
| `GATE-LIFE-03` | Deadline, fence ou cancel não cooperativo | árvore ausente em até 2 s depois do fim da grace period |
| `GATE-LIFE-04` | Terminalização concorrente | exatamente um terminal durable em 100% dos casos |
| `GATE-PERF-01` | Spawn até `AttemptPrepared`, release local e disco aquecido | p95 menor ou igual a 250 ms |
| `GATE-PERF-02` | TTFT end-to-end sob matriz comparável | regressão p95 menor ou igual a 5% contra o legado |
| `GATE-PERF-03` | Dispatch de tool nativa sem trabalho da tool | overhead p95 menor ou igual a 5 ms |
| `GATE-QUAL-01` | Conformance determinística de lifecycle/tools/policy/replay | 100% dos outcomes esperados |
| `GATE-QUAL-02` | Benchmark de eficácia agentic versionado | limite inferior do IC 95% de Rust − legado não pior que −2 pontos percentuais; zero regressão em caso crítico de segurança |
| `GATE-REL-01` | Crash/protocol/internal error atribuível ao runtime, excluindo falha de provider | no máximo 0,1% e não mais que 0,05 ponto percentual acima do legado |
| `GATE-IPC-01` | Slow consumer e payload máximo | filas permanecem nos limites declarados, sem crescimento monotônico |
| `GATE-EVT-01` | Classes A–C, tipos D declarados duráveis e terminal | paridade semântica de 100%, sem gap, inversão ou terminal antecipado |
| `GATE-POL-01` | Fence/policy/approval em chaos | zero efeito não autorizado e zero replay automático de outcome incerto |
| `GATE-REC-01` | Crash em cada fronteira de checkpoint | último checkpoint confirmado permanece legível em 100% dos casos |
| `GATE-SEC-01` | Scanner de argv, logs, frames, artifacts e dumps | zero secret em claro |
| `GATE-PKG-01` | Build empacotada suportada | binários assinados/verificados, launch e kill switch funcionais |

`GATE-MEM-03` é deliberadamente um gate de arquitetura. Se o modelo
process-per-attempt não o atingir, o programa para para otimizar código
compartilhado, hidratação, transcript quente e processo prewarm. Ele não autoriza
trocar silenciosamente para shards multi-tenant.

### 3.1 Protocolo de medição de `GATE-PERF-01`

- o binário `agent-runner` DEVE ser release e residir em target directory
  isolado da build empacotável;
- o relógio inicia imediatamente antes do spawn do SO e termina somente quando
  o Host decodifica `AttemptPrepared` após `AgentHello`;
- o child DEVE sair com sucesso depois do commit e nunca receber
  `ActivateAttempt`;
- cada processo possui timeout de 5 s; timeout, frame inesperado, EOF, status
  não zero ou processo sobrevivente falham o gate;
- a execução oficial usa ao menos 10 warm-ups e 100 amostras medidas com disco
  aquecido;
- p95 usa nearest-rank sobre microssegundos ordenados e DEVE ser menor ou igual
  a 250.000 µs;
- o relatório versionado DEVE registrar plataforma, arquitetura, profile,
  warm-up, amostras, p50, p95, p99, máximo, threshold e resultado;
- Linux, macOS e Windows executam o mesmo harness na matriz. Resultado local de
  uma plataforma não promove sozinho `G1-PERF-01`.

## 4. Fase G0 — congelar contrato e baseline

### Objetivo

Transformar este corpus em critério aceito de implementação e formar uma
baseline reproduzível sem alterar a arquitetura legada.

### Entregáveis

- aprovação de [DECISIONS.md](./DECISIONS.md) e dos specs `00` a `08`;
- lista versionada das tarefas, workspaces e cenários de falha da suíte;
- manifest inicial A01–A20 de consumidores, imports, workers, build, dados e
  critérios de retirada;
- CI com allowlist decrescente que impede novas dependências no package legado;
- harness capaz de medir árvore de processos, private/PSS, handles, threads,
  TTFT, eventos e órfãos;
- baseline do runtime legado e da aplicação Electron ociosa;
- owners para runtime, host adapter, protocol, security e rollout.

### Gate de saída

- **MIG-011 — G0.** Todos os requisitos bloqueadores têm owner; não existe
  decisão aberta sobre linguagem, unidade de isolamento, autoridade persistente,
  provider V1 ou `code_exec`; o harness repete a baseline três vezes com
  dispersão registrada; a suíte de eficácia possui corpus/métrica congelados; o
  manifest de superfícies e a fronteira de imports estão ativos.

### Não objetivos

- corrigir leaks ou runs travados no runtime legado;
- implementar o runner Rust;
- afirmar que a baseline Electron cairá com o sidecar.

## 5. Fase G1 — workspace Rust, IDL e processo mínimo

### Objetivo

Produzir uma cadeia de build e comunicação gerada, empacotável e verificável
antes de implementar o loop do agente.

### Entregáveis

- workspace e crates definidos no README;
- toolchain Rust fixada e build reprodutível para as plataformas suportadas;
- `.proto` v1, lint, breaking-change check e codegen TS/Rust;
- golden fixtures cross-language, inclusive `uint64`, presence, canonical JSON,
  unknown enum e payload máximo;
- `agentd-supervisor` capaz de autenticar host, lançar um runner vazio, completar
  handshake em duas fases e reaped-lo;
- feature probe de Job Object/cgroup/process group;
- packaging, hash, assinatura/verificação e manifest de versão.

### Gate de saída

- **MIG-012 — G1.** Bindings TS e Rust são regeneráveis sem diff; fixtures têm
  os mesmos bytes/hash; protocolo incompatível falha fechado; `GATE-PERF-01` e
  `GATE-PKG-01` passam em build empacotada.

### Stop conditions

- necessidade de tipos cross-language escritos manualmente;
- runner começa antes de `ActivateAttempt`;
- plataforma declara hard isolation sem conseguir demonstrá-la;
- processo órfão em qualquer teste de launch/failure.

## 6. Fase G2 — supervisor, ownership e isolamento

### Objetivo

Provar que cada tentativa possui fault domain, cap e reaper próprios antes de
adicionar provider ou tools reais.

### Entregáveis

- admission control por memória/processos e orçamento agregado de run-tree;
- Job Object/cgroup/process group criado antes de entregar trabalho;
- deadline absoluto, heartbeat de liveness e progress, cancel grace e hard kill;
- runner single-tenant e nunca reciclado para outro attempt;
- tracking e reaping de todos os descendentes;
- state machine completa para crash, OOM, fence, host shutdown e protocol error;
- métricas de processo e exit cause.

### Gate de saída

- **MIG-013 — G2.** `GATE-MEM-01`, `GATE-MEM-04`,
  `GATE-ISO-01` e `GATE-LIFE-01..04` passam; uma memory bomb elimina apenas o
  attempt alvo; um segundo attempt continua e chega ao terminal.

### Stop conditions

- processo pode escapar do resource group;
- attempt antigo ainda executa após fence;
- supervisor armazena transcript, catálogo mutável ou provider state;
- qualquer fila, mapa de operações ou blocking pool cresce sem limite.

## 7. Fase G3 — loop mínimo e Provider Gateway

### Objetivo

Executar uma tarefa completa no motor Rust, mantendo OAuth, adapters e streaming
físico de provider no host TypeScript.

### Entregáveis

- engine baseado nos ports normativos de `03`;
- contexto quente limitado, compactação e transcript por refs;
- Provider Gateway com start/cancel, backpressure e terminais tipados;
- tool calls parseadas, inicialmente com executor determinístico/falso;
- usage, budgets, deadlines, fallback lógico e terminal barrier;
- replay determinístico de provider fixtures.

### Gate de saída

- **MIG-014 — G3.** Conversa sem mutação completa ponta a ponta; provider é
  cancelado quando o attempt perde autoridade; `GATE-MEM-02`,
  `GATE-PERF-02`, `GATE-IPC-01` e `GATE-EVT-01` passam na matriz G3.

### Stop conditions

- OAuth ou credencial é movido para Rust como atalho;
- delta/provider payload produz fila sem limite;
- transcript integral ou output grande permanece duplicado no heap;
- EOF é tratado como sucesso implícito.

## 8. Fase G4 — capabilities, tools e `code_exec`

### Objetivo

Adicionar trabalho útil com a mesma fronteira de policy, fencing, idempotência e
resultado para tools nativas e delegadas.

### Ordem de habilitação

1. filesystem read-only, glob, grep e Git read;
2. HTTP read limitado;
3. write/edit/patch com workspace binding;
4. shell/processo/PTY com process-tree supervision;
5. Git mutation;
6. ToolHost TypeScript para MCP/plugins/LSP/browser e integrações;
7. `code_exec` descartável com proxy de capabilities;
8. environments remotos pela rota declarada no capability snapshot.

Uma classe só avança depois da classe anterior satisfazer sua matriz de
segurança e lifecycle.

### Entregáveis

- catálogo serializável e hash idêntico no host/runner;
- lifecycle `prepare → accepted → started → terminal`;
- `SealedExecutionGrant` e revalidação no ponto do efeito;
- tratamento explícito de `outcome_unknown`;
- outputs grandes como artifact mais preview;
- cancelamento por `operation_id`;
- Node/QuickJS fora do runner, no mesmo resource group e sem credenciais.

### Gate de saída

- **MIG-015 — G4.** Suites golden e adversarial passam para cada classe;
  `GATE-PERF-03`, `GATE-POL-01` e `GATE-SEC-01` passam; zero child de
  `code_exec`, shell ou PTY sobrevive ao reaper.

### Stop conditions

- mutation pode ocorrer antes do grant durable;
- timeout pós-dispatch causa retry automático;
- tool recebe path fora do binding;
- código aninhado acessa DB, credencial ou filesystem sem capability;
- catálogo executável depende de closure TypeScript no runner.

## 9. Fase G5 — durabilidade, interações e subagentes

### Objetivo

Provar execução longa e hierárquica sem manter processes ou transcripts vivos
durante espera e sem compartilhar blast radius.

### Entregáveis

- spool limitado, promoção content-addressed e GC seguro;
- checkpoint versionado e restore para novo attempt;
- interação humana que checkpointa, termina o attempt e retoma em outro;
- `SpawnChildRun` host-owned, com admission e budgets delegados;
- processo independente para todo child `AgentRun`;
- foreground/background como modos de espera do mesmo modelo;
- summaries/results bounded por refs;
- crash recovery sem repetir efeitos incertos.

### Gate de saída

- **MIG-016 — G5.** `GATE-MEM-03`, `GATE-REC-01` e a matriz de artifacts
  passam; pai e filhos respeitam budget agregado; waiting não deixa runner vivo;
  1.000 ciclos mistos não deixam artifact referenciado órfão nem processo
  residual.

### Stop conditions

- child executa como task no processo do pai;
- transcript do child é copiado integralmente para o heap do pai;
- resume reutiliza attempt/PID/fence anterior;
- GC remove conteúdo ainda referenciado;
- terminal é committed antes da promoção necessária.

## 10. Fase G6 — shadow, chaos e canário

### 10.1 Modos de shadow

- **Contract replay:** traces redigidos alimentam engine/executors falsos. É o
  primeiro modo e pode cobrir mutações sem efetuá-las.
- **Read-only shadow:** runtime Rust recebe tarefa/catálogo e executa apenas
  capabilities comprovadamente puras em ambiente descartável.
- **Decision shadow:** compara escolha de provider/tool/interaction, mas a saída
  Rust não é publicada nem produz efeito.
- **Canário exclusivo:** uma nova tentativa é roteada integralmente para Rust.

Dual execution de provider faturável ou mutation real é proibida por padrão.
Exceção exige ambiente sintético, credenciais de teste e ADR.

### 10.2 Chaos obrigatório

Falhas são injetadas:

- antes e depois de accepted/started/terminal de uma capability;
- antes, durante e depois de cada etapa de checkpoint/promotion;
- com control channel vivo e data channel bloqueado, e vice-versa;
- durante provider stream, compaction, spawn de child e terminal barrier;
- por OOM, deadline, host crash, runner crash, pipe EOF, ACK perdido, disk full,
  artifact corrupto, lease/fence revogado e slow SSE consumer;
- em symlink, junction, traversal, worktree trocado e process breakaway.

### 10.3 Escada de canário

| Estágio | Tráfego elegível | Permanência mínima | Critério adicional |
|---|---:|---:|---|
| C0 | equipe interna opt-in | 48 h | zero stop condition |
| C1 | 1% | 48 h e 200 attempts | amostra inclui tools e cancel |
| C2 | 5% | 72 h e 1.000 attempts | um ciclo completo de soak |
| C3 | 25% | 7 dias | matriz de provider/model representativa |
| C4 | 50% | 7 dias | suporte e rollback exercitado |
| C5 | 100% elegível | 14 dias | legado sem fallback acionado por regressão |

Elegibilidade pode excluir temporariamente capability ou plataforma não
certificada, mas a exclusão precisa ser visível e possuir owner/prazo.

### 10.4 Stop conditions do canário

O estágio para imediatamente em caso de:

- efeito sem autorização, escape de sandbox ou secret exposto;
- terminal duplicado, mutação duplicada ou perda de transcript durable;
- processo/resource group órfão;
- tentativa antiga aceita depois do fence;
- corrupção de artifact/checkpoint;
- crescimento monotônico que viole qualquer gate de memória;
- regressão TTFT ou taxa de erro acima do gate por duas janelas consecutivas;
- incompatibilidade que torne rollback inseguro;
- aumento material de `outcome_unknown` sem reconciliação operacional.

### Gate de saída

- **MIG-017 — G6.** Todos os gates quantitativos passam no build candidato;
  conformance, eficácia e reliability passam; chaos tem cobertura registrada;
  C0 a C4 foram concluídos sem stop condition aberta; rollback foi ensaiado sem
  transferir attempts ativos.

## 11. Rollback e kill switch

- **MIG-018 — Seleção durable.** A escolha `rust | legacy` é persistida antes
  do launch e aparece em evento/telemetria.
- **MIG-019 — Kill switch de admissão.** O host pode impedir novos attempts
  Rust imediatamente, globalmente ou por capability/plataforma.
- **MIG-020 — Attempts ativos.** Rollback não migra attempt em andamento. Ele
  permite terminalizar, cancela de forma normal ou fenceia e cria um novo
  attempt conforme policy de recovery.
- **MIG-021 — Sem execução dupla.** O host só cria recovery no outro runtime
  depois de confirmar fence e reaping, e respeita `outcome_unknown`.
- **MIG-022 — Compatibilidade para trás.** Checkpoints Rust só podem ser
  retomados pelo legado se existir conversor explicitamente testado. Na ausência
  dele, o mesmo run permanece no Rust ou é interrompido. Um novo root só nasce
  por novo `SessionCommand` explícito e idempotente; rollback nunca cria segundo
  root para o command original.
- **MIG-023 — Auditoria.** Acionamento, razão, escopo, autor, attempts afetados e
  resultado do rollback são eventos duráveis.

## 12. Fase G7 — default e aposentadoria

### Pré-condições

- C5 completo;
- A01–A20 do spec `08` estão em `rust_default`;
- todas as plataformas/capabilities declaradas como suportadas possuem suite;
- operação possui dashboard, alertas e runbook;
- não há ADR temporária vencida;
- artifacts/checkpoints necessários têm política de retenção/migração;
- fallback não foi usado por regressão do Rust durante 14 dias;
- somente o `LegacyAdapter` e fixtures congeláveis ainda podem depender do
  executor legado.

### Sequência

1. Rust vira default para novos `AgentRun`.
2. Flag de criação de novos attempts legados é desabilitada internamente.
3. Attempts legados em andamento terminam naturalmente ou são cancelados por
   política normal; o drain prova zero process/operação órfã.
4. Período de observação confirma zero dependência de fallback.
5. Testes de compatibilidade passam a usar fixtures congeladas, não o runtime
   legado vivo.
6. Dependências compartilhadas já extraídas deixam o `code-agent` como folha.
7. Adapter, entry points, workers, pools e bundles exclusivos são removidos em
   mudanças separadas e auditáveis.
8. Imports, package dependencies, scripts, assets, aliases e packaging são
   zerados; a build instalada é auditada.
9. Kill switch muda de `voltar ao legado` para `parar novas admissões Rust` e
   o rollback para uma build Rust estável é ensaiado.
10. Bridges/schema runtime-only seguem o plano de dados separado do spec `08`;
    dados de produto e migrations históricas são preservados.

### Gate final

- **MIG-024 — G7.** Nenhum caminho de produto inicia o executor legado; a
  build não empacota workers/bundles exclusivos dele; fixtures preservam o
  oracle necessário; o dependency graph externo está zerado; histórico
  permanece legível; documentação e suporte apontam apenas para o runtime Rust;
  `CUT-001..064` e os checks G7 correspondentes estão aprovados.

## 13. Definição global de concluído

O programa só está concluído quando:

- `MIG-011..024` e todos os gates quantitativos estão aprovados;
- cada requisito MUST possui implementação e cobertura rastreável;
- runtime Rust atende root, filhos, foreground, background, waiting, resume,
  provider fallback, recovery, tools, artifacts e terminal único;
- SQLite continua sem runtime de sessão e fora do alcance do Rust;
- `agent-session-store` é o writer físico único dos bundles `rust_fs_v1`,
  enquanto o Host permanece dono de policy/credenciais e decisões de produto;
- processo, memória, IPC, output e spool permanecem bounded;
- rollback já não depende de executar o code-agent;
- o runtime legado foi retirado da build de produto;
- A01–A20 foram migradas e `packages/code-agent` não possui consumidores;
- a disposição de dados separa explicitamente histórico de bridges
  runtime-only, com migrations implantadas testadas;
- a baseline Electron restante está registrada como frente separada, sem ser
  atribuída ao runtime de agentes.
