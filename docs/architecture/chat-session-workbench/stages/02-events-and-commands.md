# S2 — Eventos e comandos

> **Status:** Em andamento
> **Gate:** G2
> **Dependências:** G1 aprovado
> **Owner:** Codex, tarefa atual
> **Início:** 2026-08-01
> **Conclusão:** —
> **Última atualização:** 2026-08-01

## Objetivo

Unificar projeção live/histórica e comandos usados pelos rails, eliminando
políticas duplicadas no renderer.

## Specs autoritativas

- [Eventos e observabilidade](../specs/04-events-reconciliation-and-observability.md)
- [Backend e read model](../specs/03-backend-contracts-and-read-model.md)
- Requisitos: `CSW-EVT-*`, `CSW-LOG-*`, `CSW-NOT-*`, `CSW-CMD-*`.

## Entregáveis

- Envelope canônico e event projection.
- Backfill/tail/export do Worker Log.
- Notificações derivadas do mesmo journal.
- Command service tipado.
- Testes de replay, gaps, idempotência e batch parcial.

## Checklist

- [x] `S2-001` — Implementar union discriminada de eventos.
- [ ] `S2-002` — Implementar resource revision e invalidation mapping.
- [x] `S2-003` — Persistir identidade suficiente para dedup.
- [x] `S2-004` — Implementar query paginada de eventos.
- [x] `S2-005` — Centralizar sampling/categoria/redação/truncamento no backend.
- [ ] `S2-006` — Implementar export streaming em uma passagem.
- [ ] `S2-007` — Projetar notificações, unread, read e dismiss.
- [ ] `S2-008` — Implementar `SessionWorkbenchCommandService`.
- [ ] `S2-009` — Implementar expectedRevision/idempotency onde exigido.
- [x] `S2-010` — Implementar batch com resultado por item.
- [ ] `S2-011` — Testar reconnect, bus novo, gap e terminal duplicado.
- [x] `S2-012` — Testar restart com histórico persistido.
- [ ] `S2-013` — Instrumentar métricas bounded do workbench backend.
- [ ] `S2-014` — Aprovar Gate G2.

## Critérios de aceite

- Histórico e live tail têm o mesmo schema.
- Abrir Worker Log depois do run mostra backfill.
- Renderer não precisa categorizar/samplar payload bruto.
- Comandos publicam evento/invalidation depois do commit.
- Nenhuma mutação é repetida por shadow/reconnect.

## Evidências requeridas

| ID | Evidência | Estado | Link/comando |
|---|---|---|---|
| S2-E01 | Testes event projection | Concluída | [evidência S2](../evidence/S2-events-progress-2026-08-01.md) |
| S2-E02 | Testes replay/gap/restart | Parcial: restart verde | [evidência S2](../evidence/S2-events-progress-2026-08-01.md) |
| S2-E03 | Testes command/idempotency | Parcial: navigator/config/batch verdes | [evidência S2](../evidence/S2-events-progress-2026-08-01.md) |
| S2-E04 | Artifact de export/redação | Pendente | — |

## Log de progresso

| Data | Mudança | Resultado | Evidência |
|---|---|---|---|
| 2026-08-01 | Arquivo de controle criado | Nenhuma implementação | CSW-E000 |
| 2026-08-01 | Etapa ativada após G1 | Contrato discriminado já existe; projeção persistida de eventos é o primeiro corte | CSW-E018 |
| 2026-08-01 | Projeção histórica implementada | busId/seq/revision persistidos, normalização/redação backend, filtros, cursor e rota ETag | S2-E01, CSW-E019 |
| 2026-08-01 | Timeline e restart persistido provados | Execução usa a página canônica; restart recompõe do bundle | S2-E01, S2-E02, CSW-E019 |
| 2026-08-01 | Primeiro corte revalidado | 5 arquivos/40 testes, typecheck e diff check verdes | S2-E01, CSW-E019 |
| 2026-08-01 | Command service parcial implementado | Comandos navigator/config, revision, receipt, invalidation e batch parcial | S2-E03, CSW-E020 |
| 2026-08-01 | Duplicate tornou-se retomável | Target UUID e operation IDs determinísticos impedem segunda cópia no retry | S2-E03, CSW-E020 |
| 2026-08-01 | Segundo corte validado | 4 arquivos/37 testes e typecheck verdes | S2-E03, CSW-E020 |
| 2026-08-01 | Validação integrada | 11 arquivos/72 testes, typecheck e dashboard build verdes | CSW-E021 |

## Resumo do realizado

S2 está em andamento. A union discriminada agora possui produtor, validação
runtime e rota histórica paginada sobre o journal filesystem. Eventos novos
persistem o busId real; registros antigos recebem identidade estável sem
migração. Sampling, normalização, categoria, redação e truncamento pertencem ao
backend. A timeline lazy já usa a mesma projeção e o backfill após restart foi
provado. Attach/replay gap, invalidations amplas, export e notificações
continuam abertos.

O command service já cobre navigator, duplicate, tools, skills e batch, com
revisions e receipts persistidos. `S2-008/009` permanecem abertos somente para
integrar os comandos de read/dismiss ao owner durável de notificações.

## Desvios, riscos e decisões

- O attach do transcript não pode ser duplicado. A integração deve reutilizar
  o owner de stream ou uma distribuição interna, nunca abrir dois SSEs iguais.
- A rota histórica aguarda a barreira assíncrona de persistência antes de ler;
  o attach live deverá assinar o bus já existente, sem abrir um segundo worker
  stream.
- `commandId` é UUID e também target ID de duplicate. Esta identidade torna a
  operação retomável após falha entre criação, replay e receipt.

## Próximo handoff

S3 depende das fixtures e reducers esperados pelo contrato estabilizado em S2.
