# S5 — Reconstrução dos painéis

> **Status:** Não iniciada
> **Gate:** G5
> **Dependências:** G4 aprovado
> **Owner:** não atribuído
> **Início:** —
> **Conclusão:** —
> **Última atualização:** 2026-08-01

## Objetivo

Reconstruir os seis destinos sobre resources/selectors/commands novos, com UX e
estado próprios, sem encapsular componentes legados inteiros.

## Specs autoritativas

- [Domínio e IA](../specs/01-domain-and-information-architecture.md)
- [Arquitetura frontend](../specs/02-frontend-architecture.md)
- [UX e acessibilidade](../specs/05-ux-responsive-and-accessibility.md)
- Requisitos: `CSW-IA-001..005`, `CSW-FE-010..016`, `CSW-I18N-*`.

## Entregáveis

- Resumo.
- Contexto.
- Execução/Worker Log.
- Insights.
- Canvas.
- Configuração.
- Ação ampla de Snapshots.

## Checklist

- [ ] `S5-001` — Reconstruir Resumo com goal/tasks/todos/process/notices.
- [ ] `S5-002` — Reconstruir Contexto com files/skills/Drive/chapters/plans.
- [ ] `S5-003` — Reconstruir Execução com subagents/timeline/map.
- [ ] `S5-004` — Reconstruir Worker Log com backfill/live/filter/export.
- [ ] `S5-005` — Reconstruir Insights com views lazy.
- [ ] `S5-006` — Reconstruir Canvas preview/diagram wide.
- [ ] `S5-007` — Reconstruir Configuração skills/tools.
- [ ] `S5-008` — Integrar Snapshots como ação de cabeçalho.
- [ ] `S5-009` — Preservar view state por sessão/destino.
- [ ] `S5-010` — Padronizar loading/stale/error/empty/retry.
- [ ] `S5-011` — Completar PT-BR/EN sem hardcoded strings.
- [ ] `S5-012` — Validar foco, reader labels e reduced motion.
- [ ] `S5-013` — Medir chunks e garantir lazy boundaries.
- [ ] `S5-014` — Aprovar Gate G5.

## Critérios de aceite

- Todos os conteúdos atuais possuem destino explícito.
- Painel recebe apenas sessionId/selectors/commands necessários.
- Estado visual sobrevive à troca sem keep-alive pesado.
- Worker Log diferencia loading, sem run e filtro vazio.
- Insights não busca tabs inativas.
- Canvas promove largura sem esconder conversation de forma irrecuperável.

## Evidências requeridas

| ID | Evidência | Estado | Link/comando |
|---|---|---|---|
| S5-E01 | Testes por destino | Pendente | — |
| S5-E02 | Worker Log backfill/live | Pendente | — |
| S5-E03 | i18n/a11y | Pendente | — |
| S5-E04 | Relatório chunks/bundle | Pendente | — |
| S5-E05 | Screenshots aprovados | Pendente | — |

## Log de progresso

| Data | Mudança | Resultado | Evidência |
|---|---|---|---|
| 2026-08-01 | Arquivo de controle criado | Nenhuma implementação | CSW-E000 |

## Resumo do realizado

Etapa especificada. Nenhum painel novo foi implementado.

## Desvios, riscos e decisões

- Lógica visual pura pode ser extraída do legado; componentes que mantêm fetch,
  lifecycle ou contrato antigo não podem ser carregados como solução final.

## Próximo handoff

S6 começa apenas com paridade funcional documentada para os seis destinos.
