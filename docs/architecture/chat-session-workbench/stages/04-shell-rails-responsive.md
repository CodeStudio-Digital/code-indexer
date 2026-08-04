# S4 — Shell, rails e responsividade

> **Status:** Não iniciada
> **Gate:** G4
> **Dependências:** G3 aprovado
> **Owner:** não atribuído
> **Início:** —
> **Conclusão:** —
> **Última atualização:** 2026-08-01

## Objetivo

Construir o shell único, navigator, activity rail, dock e registry sem reutilizar
o host/switch legado como arquitetura final.

## Specs autoritativas

- [Domínio e IA](../specs/01-domain-and-information-architecture.md)
- [Arquitetura frontend](../specs/02-frontend-architecture.md)
- [UX e acessibilidade](../specs/05-ux-responsive-and-accessibility.md)
- Requisitos: `CSW-IA-*`, `CSW-FE-007..016`, `CSW-UX-001..010`.

## Entregáveis

- `SessionWorkbenchLayout`.
- `SessionNavigator` paginado/virtualizado.
- `SessionActivityRail` com seis destinos.
- `SessionDock` e chrome comum.
- Overlay narrow e sheets mobile.
- Registry de built-ins/plugins.

## Checklist

- [ ] `S4-001` — Criar shell declarativo com slots estáveis.
- [ ] `S4-002` — Criar registry e validação de definitions/collisions.
- [ ] `S4-003` — Integrar capabilities e fallback determinístico.
- [ ] `S4-004` — Implementar navigator paginado e virtualizado.
- [ ] `S4-005` — Implementar busca, filtros, grupos e seleção múltipla.
- [ ] `S4-006` — Implementar rail de seis destinos e badges.
- [ ] `S4-007` — Implementar dock padrão/wide e resize acessível.
- [ ] `S4-008` — Implementar labels hover/focus e active label.
- [ ] `S4-009` — Implementar overlay para narrow.
- [ ] `S4-010` — Implementar sheets mobile e restauração de foco.
- [ ] `S4-011` — Integrar plugins mantendo sandbox.
- [ ] `S4-012` — Implementar persistence/migration de layout.
- [ ] `S4-013` — Testar React 19 sem callback-ref state loop.
- [ ] `S4-014` — Aprovar Gate G4.

## Critérios de aceite

- O mesmo shell renderiza harness de projeto, global e compact.
- Nenhum destino desaparece por breakpoint.
- Lista com 10.000 sessões mantém DOM bounded.
- Teclado alcança rail, navigator, resize e close.
- Plugin inválido não quebra o shell.
- Abrir/fechar dock não refaz bootstrap.

## Evidências requeridas

| ID | Evidência | Estado | Link/comando |
|---|---|---|---|
| S4-E01 | Testes shell/registry | Pendente | — |
| S4-E02 | Benchmark navigator | Pendente | — |
| S4-E03 | Testes teclado/a11y | Pendente | — |
| S4-E04 | Matriz visual responsiva | Pendente | — |
| S4-E05 | Regressão React 19 | Pendente | — |

## Log de progresso

| Data | Mudança | Resultado | Evidência |
|---|---|---|---|
| 2026-08-01 | Arquivo de controle criado | Nenhuma implementação | CSW-E000 |

## Resumo do realizado

Etapa especificada. Shell e componentes de navegação novos ainda não foram
implementados.

## Desvios, riscos e decisões

- `react-resizable-panels` pode continuar sendo usado, mas sizes e ownership não
  podem ficar divididos entre shell e `AgentChat`.

## Próximo handoff

S5 recebe o chrome, registry e panel contract já estabilizados.
