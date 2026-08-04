# S0 — Governança, contrato e baseline

> **Status:** Concluída
> **Gate:** G0
> **Dependências:** nenhuma
> **Owner:** Codex, tarefa atual
> **Início:** 2026-08-01
> **Conclusão:** 2026-08-01
> **Última atualização:** 2026-08-01

## Objetivo

Converter as specs em contrato implementável e congelar uma baseline
reproduzível antes de tocar o produto.

## Specs autoritativas

- [Escopo e baseline](../specs/00-scope-and-baseline.md)
- [Domínio e IA](../specs/01-domain-and-information-architecture.md)
- [Verificação e gates](../specs/07-verification-and-performance-gates.md)
- Requisitos: `CSW-SCOPE-*`, `CSW-INV-*`, `CSW-IA-*`, `CSW-PERF-*`.

## Entregáveis

- ADR/decisões confirmadas.
- Schemas de contrato desenhados e consumer map.
- Baseline de rede, render, bundle, UI e regressões.
- Plano de PRs, owners e riscos.

## Checklist

- [x] `S0-001` — Recontar LOC/hooks/imports no worktree corrente.
- [x] `S0-002` — Inventariar consumers de SessionSidebar/RightPanel/Worker Log.
- [x] `S0-003` — Capturar requests/bytes de abertura e alternância de painéis.
- [x] `S0-004` — Capturar React Profiler em run com burst diagnóstico.
- [x] `S0-005` — Capturar matriz visual inicial.
- [x] `S0-006` — Executar regressão de sessão global e reattach.
- [x] `S0-007` — Criar fixture de 1.000/10.000 sessões para benchmark.
- [x] `S0-008` — Definir schemas compartilhados sem campos `unknown`.
- [x] `S0-009` — Produzir mapa endpoint → owner → artifact filesystem.
- [x] `S0-010` — Registrar riscos, owners e ordem de PRs.
- [x] `S0-011` — Verificar alterações concorrentes nos arquivos em escopo.
- [x] `S0-012` — Aprovar Gate G0 no checklist mestre.

## Critérios de aceite

- Baseline pode ser repetida por outra pessoa.
- Toda superfície e endpoint atual têm owner identificado.
- Contratos cobrem todos os conteúdos dos seis destinos.
- Nenhuma decisão crítica está implícita em comentário de código.
- Comandos, outputs e artifacts estão registrados como evidência.

## Evidências requeridas

| ID | Evidência | Estado | Link/comando |
|---|---|---|---|
| S0-E01 | Relatório estrutural | Concluída | [baseline](../evidence/S0-baseline-2026-08-01.md) |
| S0-E02 | Trace/render baseline | Concluída | Hook React + bursts de 500 eventos; ver baseline §5 |
| S0-E03 | Rede/bytes baseline | Concluída | Fanout/bytes por fase; ver baseline §5 |
| S0-E04 | Matriz visual | Concluída | 1920/1440/1280/mobile; ver baseline §6 |
| S0-E05 | Testes/build baseline | Concluída | 67 testes, build e typecheck verdes; ver baseline §4 |
| S0-E06 | Contrato compartilhado | Concluída | `packages/api-bus/src/coder-session-workbench.ts`; 12 testes verdes |
| S0-E07 | Fixture 1k/10k | Concluída | `node benchmarks/session-workbench/fixture.mjs` |

## Log de progresso

| Data | Mudança | Resultado | Evidência |
|---|---|---|---|
| 2026-08-01 | Arquivo de controle criado | Etapa preparada; execução não iniciada | CSW-E000 |
| 2026-08-01 | Etapa ativada | Inventário e baseline iniciados antes de alterações de produto | Pendente |
| 2026-08-01 | Baseline estática e regressão capturadas | Estrutura, consumers, ownership, 67 testes, build e typecheck registrados | S0-E01, S0-E05 |
| 2026-08-01 | Runtime local verificado | Porta 7317 sem listener; evidências live mantidas abertas | S0-E02..E04 |
| 2026-08-01 | Contrato público v1 introduzido | Tipos de todos os resources, eventos/comandos e parsers bounded; sem `unknown`/`any` | S0-E06 |
| 2026-08-01 | Fixture determinística adicionada | 1.000 itens em 3,742 ms e 10.000 em 21,877 ms; invariantes aprovadas | S0-E07 |
| 2026-08-01 | Rotas Playwright alinhadas ao HashRouter | Falha inicial 3/3 virou regressão global/reattach 6/6 verde | S0-E04, S0-E08 |
| 2026-08-01 | Rede/render/visual medidos | 23 requests e ~1,61 MB na abertura; bursts aberto/fechado e quatro viewports registrados | S0-E02..E04 |
| 2026-08-01 | Gate G0 aprovado | Todos os entregáveis de baseline, contrato, risco e fixture possuem evidência | CSW-E001..E008 |

## Resumo do realizado

S0 foi concluída. O escopo corrente foi isolado de mudanças Unity não
relacionadas; a estrutura, consumers, owners, testes, build e typecheck foram
registrados. Foi criada a fixture determinística de escala e o primeiro código
da refatoração: contrato público v1 em `@mcp/api-bus`, cobrindo lista,
bootstrap, seis destinos, eventos e comandos sem campos `unknown`/`any`.
Rede, commits React, bursts de Worker Log, quatro viewports e reattach global
foram medidos. A baseline mostrou 23 requests/~1,61 MB na abertura, repetição
de chapters em toda troca e ~985 kB adicionais na Configuração. G0 foi aprovado.

## Desvios, riscos e decisões

- O worktree contém mudanças concorrentes fora do escopo em Unity; owner:
  tarefa externa. Regra: nunca incluir, normalizar ou reverter esses paths.
- O baseline E2E depende de backend em 7333 e Vite temporário em 7317; owner:
  S7 na repetição final. O processo temporário deve ser encerrado pelo PID.
- Regressão de portais React 19; owner: S3/S4. Preservar callback refs estáveis
  e provar mounts global/projeto no gate.
- Drift de SSE/replay e duas autoridades de Worker Log; owner: S2/S3. Um único
  attach/store por sessão e uma projeção backend são condições de cutover.
- Contribuições de plugins; owner: S4. Registry novo deve validar capability,
  colisão e sandbox antes de aceitar destinos.

### Ordem de PRs/entregas

1. S0: baseline, contrato compilável e fixture, sem montar handlers legados.
2. S1: query service/read model e endpoints novos, mantendo filesystem owner.
3. S2: eventos, replay, Worker Log e command service tipados.
4. S3: store/controller/query client canônicos.
5. S4/S5: shell/rails e painéis reconstruídos sobre as novas fronteiras.
6. S6: cutover único e remoção física do legado.
7. S7: matriz final, budgets, release e runbook.

## Próximo handoff

S1 está autorizada a implementar o query service e as rotas novas. Manter o
contrato desacoplado do `CoderApi` agregado até o handler existir, evitando um
adapter vazio ou uma implementação de fachada.
