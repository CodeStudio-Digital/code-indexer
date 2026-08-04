# S3 — Store e controller frontend

> **Status:** Não iniciada
> **Gate:** G3
> **Dependências:** G2 aprovado
> **Owner:** não atribuído
> **Início:** —
> **Conclusão:** —
> **Última atualização:** 2026-08-01

## Objetivo

Implementar ownership frontend único por sessão, com selectors isolados e
reconciliação independente da árvore visual.

## Specs autoritativas

- [Arquitetura frontend](../specs/02-frontend-architecture.md)
- [Eventos e reconciliação](../specs/04-events-reconciliation-and-observability.md)
- Requisitos: `CSW-FE-001..016`, `CSW-EVT-005..008`.

## Entregáveis

- `SessionWorkbenchStore`.
- Query client/invalidation.
- Reducers snapshot/event.
- `SessionWorkbenchController`.
- Adapters de host sem UI final.

## Checklist

- [ ] `S3-001` — Criar modelo de slots por sessão e resources.
- [ ] `S3-002` — Implementar selectors estáveis e subscriptions focadas.
- [ ] `S3-003` — Implementar request tokens, abort e stale-response guard.
- [ ] `S3-004` — Implementar reducers de bootstrap e resource snapshot.
- [ ] `S3-005` — Implementar reducers de evento, revision e invalidation.
- [ ] `S3-006` — Implementar bus/seq dedup e replay-gap state.
- [ ] `S3-007` — Implementar eviction LRU e caps.
- [ ] `S3-008` — Implementar `SessionPanelViewState` separado.
- [ ] `S3-009` — Implementar controller e commands de navegação.
- [ ] `S3-010` — Implementar adapters projeto/global/editor/App Studio Coder.
- [ ] `S3-011` — Provar zero render cruzado por selector.
- [ ] `S3-012` — Provar A → B → A durante run.
- [ ] `S3-013` — Provar snapshot antigo após evento novo.
- [ ] `S3-014` — Aprovar Gate G3.

## Critérios de aceite

- Store funciona em harness sem `AgentChat`.
- Duas superfícies da mesma sessão observam uma única entrada.
- Troca de sessão não apaga run vivo.
- Evento de Execução não publica novo snapshot da Conversa.
- Buffers e slots possuem limits e testes de eviction.

## Evidências requeridas

| ID | Evidência | Estado | Link/comando |
|---|---|---|---|
| S3-E01 | Testes de reducers | Pendente | — |
| S3-E02 | Testes de concorrência/replay | Pendente | — |
| S3-E03 | Testes de selectors/renders | Pendente | — |
| S3-E04 | Testes de eviction/caps | Pendente | — |

## Log de progresso

| Data | Mudança | Resultado | Evidência |
|---|---|---|---|
| 2026-08-01 | Arquivo de controle criado | Nenhuma implementação | CSW-E000 |

## Resumo do realizado

Etapa especificada. Store, controller e adapters novos ainda não existem.

## Desvios, riscos e decisões

- Não inserir novos hooks no meio do lifecycle compartilhado atual como ponte.
  O controller deve nascer em módulo isolado e ser montado pelo novo shell.

## Próximo handoff

S4 consome apenas interfaces públicas testadas do controller/store.
