# Benchmark ao vivo de memória entre sessões — Kanban

Data: 2026-07-29/30  
Projeto de teste: React + TypeScript + shadcn, em
`D:\MCP\.tmp\memory-kanban-benchmark`  
Provider: Z.AI  
Modelos comparados: `glm-4.7` e `glm-5.2`

## Objetivo

Medir se a memória do projeto ajuda um agente a continuar trabalho iniciado em
outra sessão, preservando contratos e decisões que não estavam repetidos no
prompt seguinte. O teste não mede apenas resposta textual: cada sessão editou o
projeto, executou testes e build, e o resultado foi verificado de forma
independente.

## Protocolo

1. Uma sessão criou a fundação do Kanban e definiu o contrato realtime.
2. Outra sessão continuou o projeto e implementou mutações otimistas.
3. Uma terceira sessão recebeu somente um bug de desconexão, sem repetir o
   contrato completo.
4. Para cada modelo, foram comparados projetos equivalentes com memória ligada e
   desligada.
5. As sessões oficiais de `glm-4.7` foram configuradas como `unrestricted`
   (Sem Impedimento) antes do envio do prompt.

Contrato histórico que deveria ser preservado:

- evento com `eventId`, `boardId`, `revision`, `clientMutationId`, `type` e
  `payload`;
- ignorar eventos com `revision <= appliedRevision`;
- confirmação e rollback correlacionados por `clientMutationId`;
- nenhuma criação de protocolo paralelo.

## Resultado comparativo

### GLM 5.2 — continuidade arquitetural

| Métrica | Memória ON | Memória OFF | Variação ON |
|---|---:|---:|---:|
| Duração | 399,8 s | 323,0 s | +23,8% |
| Turnos | 45 | 33 | +36,4% |
| Ferramentas | 57 | 44 | +29,5% |
| Erros de ferramenta | 3 | 3 | 0 |
| Input tokens | 1.165.102 | 964.007 | +20,9% |
| Output tokens | 15.154 | 17.837 | -15,0% |
| Testes finais | 16/16 | 14/14 | — |
| Contrato histórico | preservado | alterado | — |

Sessão com memória:
`1f0f9c6a-d2ae-4617-9aa9-0ce4e76d6270`

Sessão sem memória:
`7e47cd47-7380-4081-a211-00f47ad8bbac`

Conclusão: no modelo forte, a memória teve utilidade objetiva. A sessão sem
memória inventou `kind`, omitiu `eventId`/`boardId` e criou uma confirmação
separada. A sessão com memória preservou as seis propriedades e as regras de
ordenação/correlação. O ganho de fidelidade custou mais tempo e chamadas.

### GLM 4.7 — robustez com modelo mais fraco

| Métrica | Memória ON | Memória OFF | Variação ON |
|---|---:|---:|---:|
| Duração | 791,3 s | 411,7 s | +92,2% |
| Turnos | 37 | 24 | +54,2% |
| Ferramentas | 39 | 26 | +50,0% |
| Erros de ferramenta | 4 | 0 | +4 |
| Input tokens | 831.534 | 546.512 | +52,2% |
| Output tokens | 7.380 | 5.587 | +32,1% |
| Testes finais | 19/19 | 20/20 | — |
| Critérios observáveis cobertos | 2/3 | 3/3 | — |

Sessão com memória:
`54eaf735-bc63-44fc-8746-9330fd8569d7`

Sessão sem memória:
`facc8332-2a7b-4032-bfb0-e41a15495657`

Conclusão: com o catálogo existente, a memória prejudicou o modelo fraco. A
sessão ON leu memórias automáticas duplicadas e conflitantes, demorou quase o
dobro e produziu testes menos rigorosos. A sessão OFF cobriu callback tardio de
confirmação e rejeição e criou um cliente realmente novo após desconectar. Sua
decisão de resolver, em vez de rejeitar, a Promise desfeita é semanticamente
discutível, mas os três critérios observáveis do prompt foram exercitados.

Os números de input incluem leitura de cache: as quatro sessões oficiais tiveram
aproximadamente 95%–96% de cache read. Portanto, input tokens não equivalem
diretamente a custo de tokens não cacheados.

## Diagnóstico confirmado

A memória funciona quando contém poucas decisões canônicas e o modelo consegue
usá-las para restringir a solução. Ela piora o agente quando o índice expõe
várias destilações da mesma sessão como se fossem fatos independentes.

No projeto com memória havia, entre outras, várias versões do mesmo fato:

- `optimistic-state-persists-indefinitely-after-socket`;
- `optimistic-mutation-state-leak-on-disconnect`;
- `optimistic-mutation-persistence-on-disconnect`;
- `optimistic-mutation-rollback-on-disconnect`;
- `disconnect-rollback-fix`.

O problema principal não era ausência de RAG. Era curadoria, proveniência e
seleção excessiva.

## Correções aplicadas no produto

### Memória e preflight

- o índice agora carrega `source`;
- memória explícita de usuário/agente tem prioridade sobre destilação automática
  de sessão;
- títulos quase duplicados são diversificados antes de montar o catálogo;
- a busca central de memória agora colapsa paráfrases automáticas por conteúdo e
  conceitos do título; se houver uma versão explícita de usuário/agente, ela
  substitui a destilação automática sem perder o melhor score do grupo;
- o preflight recebe e renderiza a proveniência;
- o prompt curto do preflight instrui escolher no máximo uma memória por fato;
- o teto do preflight caiu de cinco para três memórias;
- projeto com memória desativada não recebe `recall_memory`;
- reconciliação semântica passou a ser por namespace do projeto, sem reindexação
  global desnecessária.

### Execução dos agentes

- `submit_plan` ficou restrito ao modo Plan;
- `task_list(gate: approve)` não pode pausar o modo Build;
- o schema e a instrução de `task_list` no Build foram reduzidos;
- `edit_file`, `write_file` e `run_command` não são removidos do conjunto
  efetivo por trimming;
- o nudge de self-review foi tornado opt-in no runner e desativado (`0`) na
  configuração DB do runtime usado no benchmark;
- o smoke pós-correção recebeu limite explícito de um turno e zero
  auto-continuações, sem depender de um teto global;
- o sweeper de memória não trabalha sobre sessão ainda ativa.

Essas mudanças atacam os bloqueios observados no benchmark: plano pedindo
aprovação em modo Build, ausência de ferramentas básicas, revisão obrigatória
sem fim e memórias automáticas redundantes.

## Smokes pós-correção

### Ranking e proveniência

Sessão intermediária:
`7a45ce47-c924-4301-9de2-fdc62b3a0856`

Configuração:

- modelo `glm-4.7`;
- `tool_permission_mode=unrestricted`;
- um turno, zero auto-continuações;
- análise somente leitura.

Resultado:

- 63,2 s;
- HTTP 200;
- zero eventos de aprovação;
- API permaneceu ativa;
- o preflight escolheu primeiro as três memórias canônicas:
  `optimistic-mutation-rollback-rule`,
  `realtime-transport-event-contract` e
  `revision-ordering-rule-for-incoming-events`;
- depois escolheu somente duas exceções específicas de sessão;
- o agente efetivamente consultou as decisões por nome.

Esse smoke validou o novo ranking no fluxo real, não apenas em teste unitário.
Ele também mostrou a redundância residual: cinco chamadas no primeiro turno,
incluindo uma busca ampla e quatro recalls com resultados sobrepostos.

### Recuperação cirúrgica final

Sessão final:
`9c763deb-4f84-44c9-83af-7b7b4d191e08`

Depois da deduplicação central e do teto de três memórias:

| Métrica | Smoke intermediário | Smoke final | Variação |
|---|---:|---:|---:|
| Duração | 63,2 s | 33,1 s | -47,6% |
| Memórias no seed | 5 | 3 | -40,0% |
| Chamadas de ferramenta | 5 | 4 | -20,0% |
| Bytes SSE | 27.702 | 24.131 | -12,9% |
| Eventos de aprovação | 0 | 0 | — |

O preflight final escolheu:

- `optimistic-mutation-rollback-rule`;
- `disconnect-rollback-fix`;
- `optimistic-rollback-must-preserve-interleaved-authoritative`.

O `glm-4.7` abriu essas três e acrescentou apenas a regra de ordenação por
revisão, sem repetir a busca semântica ampla. A consulta RPC real de memória
também deixou de devolver cinco paráfrases do bug e passou a retornar correção,
preservação de evento autoritativo, sintoma, regra canônica e seam por
`clientMutationId`.

## Ensaios excluídos da comparação

Tentativas com `glm-4.7-flash` foram mantidas como evidência operacional, mas
excluídas do A/B:

- uma aguardou `submit_plan`;
- outra não recebeu `run_command`;
- duas ficaram presas em `task_list(gate: approve)`;
- uma chamada sem memória encerrou com HTTP 429;
- uma execução completou parcialmente, mas sem cumprir todos os critérios.

Esses ensaios não são comparáveis ao par oficial `glm-4.7`.

## Artefatos

- ON oficial 4.7:
  `D:\MCP\.tmp\memory-kanban-benchmark\glm47-on-official`
- OFF oficial 4.7:
  `D:\MCP\.tmp\memory-kanban-benchmark\glm47-off-official`
- SSE ON:
  `D:\MCP\.tmp\memory-kanban-benchmark\05m-glm47-official.sse`
- SSE OFF:
  `D:\MCP\.tmp\memory-kanban-benchmark\05c-glm47-official.sse`
- SSE do smoke pós-ranking:
  `D:\MCP\.tmp\memory-kanban-benchmark\08-preflight-ranking-smoke.sse`
- SSE do smoke cirúrgico final:
  `D:\MCP\.tmp\memory-kanban-benchmark\09-final-surgical-smoke.sse`
- resultado parcial Flash:
  `D:\MCP\.tmp\memory-kanban-benchmark\flash-result`

## Veredito

Não existe um único resultado “memória é boa” ou “memória é inútil”:

- com `glm-5.2`, ela protegeu um contrato que a sessão sem memória perdeu;
- com `glm-4.7`, o catálogo poluído tornou a execução pior;
- após priorizar proveniência e reduzir duplicidade, o smoke do modelo fraco
  passou a começar pelas decisões canônicas;
- deduplicar o retriever e limitar o seed a três reduziu pela metade o tempo do
  smoke sem adicionar instruções ao prompt.

O caminho de maior efetividade é manter o prompt pequeno e tornar a recuperação
seletiva, com memória explícita/canônica acima de destilações automáticas.
