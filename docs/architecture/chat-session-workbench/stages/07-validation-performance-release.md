# S7 — Validação, performance e release

> **Status:** Não iniciada
> **Gate:** G7
> **Dependências:** G6 aprovado
> **Owner:** não atribuído
> **Início:** —
> **Conclusão:** —
> **Última atualização:** 2026-08-01

## Objetivo

Provar a solução final sem legado, cumprir budgets e preparar operação/release.

## Specs autoritativas

- [Verificação e performance](../specs/07-verification-and-performance-gates.md)
- Todos os specs anteriores.
- Requisitos: `CSW-PERF-*`, gates G0–G7 e invariantes finais.

## Entregáveis

- Suítes finais verdes.
- Matriz E2E/visual/a11y.
- Relatório before/after de rede, render, bundle e memória.
- Runbook, troubleshooting e release notes.
- Checklist global concluído.

## Checklist

- [ ] `S7-001` — Executar todas as suítes de contrato/backend.
- [ ] `S7-002` — Executar todas as suítes store/reconciliação.
- [ ] `S7-003` — Executar testes UI/registry/panels.
- [ ] `S7-004` — Executar E2E projeto/global/editor/App Studio Coder.
- [ ] `S7-005` — Executar reconnect/restart/session-switch durante run.
- [ ] `S7-006` — Executar matriz visual desktop/narrow/mobile.
- [ ] `S7-007` — Executar auditoria de teclado/foco/contraste/reader.
- [ ] `S7-008` — Medir requests, bytes e bootstrap.
- [ ] `S7-009` — Medir 50 eventos/s e commits React.
- [ ] `S7-010` — Medir navigator com 10.000 sessões.
- [ ] `S7-011` — Medir bundle/chunks e buffers.
- [ ] `S7-012` — Executar build, typecheck aplicável e diff check.
- [ ] `S7-013` — Documentar baseline noise separadamente, se existir.
- [ ] `S7-014` — Atualizar runbook e troubleshooting.
- [ ] `S7-015` — Atualizar release notes e estratégia de observação.
- [ ] `S7-016` — Auditar invariantes `FINAL-01..12`.
- [ ] `S7-017` — Aprovar Gate G7 e status global Concluído.

## Critérios de aceite

- Todos os budgets `CSW-PERF-001..010` aprovados ou exceção via ADR.
- Nenhum teste alvo falha.
- Falha ampla preexistente possui comando, erro, baseline e owner.
- Build final não contém legado.
- Runbook permite diagnosticar bootstrap, stale resource, replay gap e plugin.
- Checklist mestre e resumos de todas as etapas estão atualizados.

## Evidências requeridas

| ID | Evidência | Estado | Link/comando |
|---|---|---|---|
| S7-E01 | Relatório de testes | Pendente | — |
| S7-E02 | Relatório E2E/visual/a11y | Pendente | — |
| S7-E03 | Relatório performance | Pendente | — |
| S7-E04 | Build/package inspection | Pendente | — |
| S7-E05 | Runbook/release notes | Pendente | — |

## Log de progresso

| Data | Mudança | Resultado | Evidência |
|---|---|---|---|
| 2026-08-01 | Arquivo de controle criado | Nenhuma validação final | CSW-E000 |

## Resumo do realizado

Etapa especificada. Nenhuma validação ou release da refatoração foi executada.

## Desvios, riscos e decisões

- “Build passou” isoladamente não aprova release; os budgets e cenários de
  replay/session switching são gates independentes.

## Próximo handoff

Após G7, qualquer trabalho residual deve ser aberto como nova iniciativa; não
deixar TODO silencioso no corpus concluído.
