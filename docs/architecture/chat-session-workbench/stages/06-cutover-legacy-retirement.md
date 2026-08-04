# S6 — Cutover e retirada do legado

> **Status:** Não iniciada
> **Gate:** G6
> **Dependências:** G5 aprovado
> **Owner:** não atribuído
> **Início:** —
> **Conclusão:** —
> **Última atualização:** 2026-08-01

## Objetivo

Migrar todas as superfícies para o novo workbench e remover fisicamente o
caminho legado, suas flags e seus contratos exclusivos.

## Specs autoritativas

- [Migração e retirada](../specs/06-migration-cutover-and-retirement.md)
- [Verificação](../specs/07-verification-and-performance-gates.md)
- Requisitos: `CSW-MIG-*`, `CSW-CUT-*`, `CSW-INV-*`.

## Entregáveis

- Cutover projeto/global/editor/App Studio Coder.
- Migration de preferências.
- Inventário e deleção do legado.
- Grafo de imports e build output limpos.
- Rollback drill documentado.

## Checklist

- [ ] `S6-001` — Ativar projeto no shell novo e validar gate da superfície.
- [ ] `S6-002` — Ativar global e validar portal/replay/linked projects.
- [ ] `S6-003` — Ativar editor compact rail.
- [ ] `S6-004` — Ativar wrapper Coder do App Studio.
- [ ] `S6-005` — Migrar IDs/preferências de painel e layout.
- [ ] `S6-006` — Provar um attach/store por sessão.
- [ ] `S6-007` — Remover render blocks antigos de `AgentChat`.
- [ ] `S6-008` — Remover host/switch/activity rail legados.
- [ ] `S6-009` — Remover fetches/hooks/stores/eventos DOM exclusivos.
- [ ] `S6-010` — Remover endpoints sem consumidores.
- [ ] `S6-011` — Remover traduções, CSS, testes e chunks mortos.
- [ ] `S6-012` — Remover feature flag e adapters temporários.
- [ ] `S6-013` — Executar grafo/busca estática e inspeção de build output.
- [ ] `S6-014` — Executar rollback drill antes da deleção final.
- [ ] `S6-015` — Executar build/testes após deleção.
- [ ] `S6-016` — Aprovar Gate G6.

## Critérios de aceite

- Todos os mounts usam controller/store/shell novos.
- Nenhum código antigo executa ou empacota.
- Não existe dual-write, dual-attach ou adapter sem owner/prazo.
- Preferências antigas resultam em fallback válido.
- Runs e histórico existentes continuam acessíveis.

## Evidências requeridas

| ID | Evidência | Estado | Link/comando |
|---|---|---|---|
| S6-E01 | E2E por superfície | Pendente | — |
| S6-E02 | Grafo de imports zero | Pendente | — |
| S6-E03 | Build output sem legado | Pendente | — |
| S6-E04 | Migration de preferências | Pendente | — |
| S6-E05 | Rollback drill | Pendente | — |

## Log de progresso

| Data | Mudança | Resultado | Evidência |
|---|---|---|---|
| 2026-08-01 | Arquivo de controle criado | Nenhuma implementação | CSW-E000 |

## Resumo do realizado

Etapa especificada. Nenhuma superfície foi migrada e nenhum arquivo legado foi
removido.

## Desvios, riscos e decisões

- A deleção deve respeitar mudanças concorrentes do worktree. Arquivos alterados
  por outra iniciativa exigem reconciliação explícita, nunca overwrite.

## Próximo handoff

S7 valida o source tree já sem legado; não valida uma build ainda sob flag.
