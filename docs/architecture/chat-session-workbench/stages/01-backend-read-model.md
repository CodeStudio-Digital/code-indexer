# S1 — Backend read model

> **Status:** Concluída
> **Gate:** G1
> **Dependências:** G0 aprovado
> **Owner:** Codex, tarefa atual
> **Início:** 2026-08-01
> **Conclusão:** 2026-08-01
> **Última atualização:** 2026-08-01

## Objetivo

Implementar o BFF/read model tipado e bounded do Session Workbench sobre os
owners filesystem e catálogos existentes.

## Specs autoritativas

- [Backend e read model](../specs/03-backend-contracts-and-read-model.md)
- [Escopo](../specs/00-scope-and-baseline.md)
- Requisitos: `CSW-API-001..019`, `CSW-SCOPE-005..006`.

## Entregáveis

- Contratos compartilhados compiláveis.
- Query service isolado.
- Lista paginada e bootstrap.
- Resources paginados por domínio.
- Testes de limits, ownership e compatibilidade.

## Checklist

- [x] `S1-001` — Criar schemas/types do workbench em `@mcp/api-bus`.
- [x] `S1-002` — Montar módulo HTTP `coder/session-workbench`.
- [x] `S1-003` — Implementar `SessionWorkbenchQueryService` e resources de
  leitura por domínio.
- [x] `S1-004` — Implementar lista paginada com busca/filtros/grupos.
- [x] `S1-005` — Implementar bootstrap pequeno com revision/capabilities/badges.
- [x] `S1-006` — Implementar resource Contexto paginado.
- [x] `S1-007` — Implementar resource Execução paginado. Subagentes e processos
  são lidos agora; timeline declara `event_projection_pending` até S2.
- [x] `S1-008` — Implementar views de Insights paginadas/lazy.
- [x] `S1-009` — Implementar views de Configuração.
- [x] `S1-010` — Implementar ETag, conditional GET e coalescência bounded.
- [x] `S1-011` — Validar requests e responses profundamente no boundary e
  emitir erros estruturados sem payload interno.
- [x] `S1-012` — Provar que lista não abre todos os bundles.
- [x] `S1-013` — Provar ausência de migration SQLite.
- [x] `S1-014` — Atualizar consumer/endpoint map.
- [x] `S1-015` — Aprovar Gate G1.

## Critérios de aceite

- Todas as responses são tipadas e carregam session/revision quando aplicável.
- Nenhum endpoint retorna lista ilimitada.
- Bootstrap respeita budget de bytes.
- Query service não escreve.
- Testes cobrem erro, paginação, cursor, stale revision e scope global/projeto.

## Evidências requeridas

| ID | Evidência | Estado | Link/comando |
|---|---|---|---|
| S1-E01 | Testes de contrato | Concluída | 19 testes `@mcp/api-bus` |
| S1-E02 | Testes de query/routes | Concluída | 12 testes list/bootstrap/resources/cursor/ETag/response |
| S1-E03 | Relatório de bytes/queries | Concluída | Lista 5/120; bootstrap <10 kB; HTTP 1k/10k com 100 hidratações |
| S1-E04 | Prova filesystem/no SQLite | Concluída | Catálogo/bundle only; zero referência nas migrations |
| S1-E05 | Validação ampla | Concluída | 50 testes, typecheck, dashboard build e diff check verdes |

## Log de progresso

| Data | Mudança | Resultado | Evidência |
|---|---|---|---|
| 2026-08-01 | Arquivo de controle criado | Nenhuma implementação | CSW-E000 |
| 2026-08-01 | Etapa ativada após G0 | Contrato v1 já compilado e testado; módulo HTTP/query service são o próximo corte | CSW-E003 |
| 2026-08-01 | Lista do read model implementada | Boundary, filtros, grupos, cursor/revision, ETag e erros estruturados | S1-E01, S1-E02 |
| 2026-08-01 | Paginação provada antes da hidratação | Página 5/120 abriu somente cinco bundles | S1-E03 |
| 2026-08-01 | Ownership auditado | Projeção usa SessionCatalog/FsSessionStore; nenhuma migration SQLite | S1-E04 |
| 2026-08-01 | Bootstrap implementado | Summary, revisions, capabilities, badges honestos, projetos vinculados e liveness sem ler journal | S1-E01, S1-E02, S1-E03 |
| 2026-08-01 | Cache HTTP concluído para o corte atual | Lista/bootstrap respondem ETag/304; leituras concorrentes idênticas são coalescidas em mapa limitado a 64 chaves | S1-E02 |
| 2026-08-01 | Resources lazy concluídos | Contexto, Execução, Insights e Configuração têm views discriminadas, paginação, cursors/revisions e ETag próprios | S1-E01, S1-E02 |
| 2026-08-01 | Owners bounded ampliados | Capítulos, subagentes, task runs e summaries de skills expõem páginas/revisions; prompt body não entra no catálogo | S1-E04, S1-E05 |
| 2026-08-01 | Boundary de response fechado | Validação runtime profunda rejeita itens inválidos e retorna `invalid_response` estruturado | S1-E01, S1-E02 |
| 2026-08-01 | Benchmark HTTP executado | 1k: 25,940 ms; 10k: 63,922 ms; ~57,8 kB; 100 hidratações por página | S1-E03 |
| 2026-08-01 | Tool insights deixou o caminho legado | JSONL é projetado em streaming, preserva rollback e não materializa a conversa | S1-E04, S1-E05 |
| 2026-08-01 | Validação ampla concluída | 50 testes, typecheck raiz, build e diff check do escopo aprovados | S1-E05 |
| 2026-08-01 | Prova do processo ativo | GET na rota nova retornou 404 porque o backend ainda não foi reiniciado | S1-E05 |
| 2026-08-01 | Smoke HTTP em socket efêmero | List/bootstrap/context passaram em 200/304 e erro de query em 400 estruturado; typecheck verde | S1-E05, CSW-E018 |
| 2026-08-01 | Gate G1 aprovado | Fonte S1 concluído; deployment do artefato instalado permanece para S7 | CSW-E018 |

## Resumo do realizado

S1 está concluída. Contrato, módulo HTTP, lista, bootstrap e os quatro
resources lazy estão implementados. A lista pagina antes de hidratar; o
bootstrap lê somente sessão, goal, tasks e contagem de capítulos. Cada subview
lazy possui cursor/revision independente, ETag/304 e coalescência bounded. O
boundary valida objetos e itens aninhados antes de responder. Cinquenta
testes, benchmark 1k/10k, typecheck, build do dashboard e diff check do escopo
passaram. O smoke TCP efêmero provou as rotas públicas e conditional GET. O
runtime instalado não foi interrompido porque aponta para outro artefato.

## Desvios, riscos e decisões

- Rotas antigas podem continuar ativas durante S1, mas o backend novo não deve
  escrever nem exigir mudanças do rail antigo.
- Badges da linha permanecem explicitamente `pending` até a projeção de eventos
  S2; o endpoint não publica zeros como se fossem dados autoritativos.
- Badges do bootstrap declaram disponibilidade por campo. Capítulos são
  medidos no bootstrap; eventos, snapshots, subagentes e configuração ficam
  `pending` até seus owners lazy serem consultados.
- Timeline de execução é contrato do resource, mas sua projeção persistida/live
  pertence a S2 e responde honestamente `event_projection_pending` em S1.
- O domínio de pipelines foi retirado em alteração concorrente fora desta
  iniciativa; o bootstrap foi alinhado ao owner atual sem facade de legado.
- A primeira execução ampla encontrou três referências Company/pipeline de uma
  alteração concorrente; o owner externo estabilizou o corte e a reexecução de
  `npm run typecheck` passou sem alteração do Workbench nesses arquivos.
- O runtime em `Program Files` não carrega código da worktree; a prova de fonte
  usa socket efêmero e o rollout do pacote permanece no gate de release S7.

## Próximo handoff

S2 recebe contrato v1, projeções bounded e fixtures aprovadas para implementar
journal, replay, Worker Log, notificações e command service sem alterar o rail
legado.
