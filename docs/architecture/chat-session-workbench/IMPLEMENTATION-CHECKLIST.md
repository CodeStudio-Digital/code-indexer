# Chat Session Workbench — controle executivo

> **Status global:** Em andamento
> **Etapa ativa:** S2 — Eventos e comandos
> **Última atualização:** 2026-08-01
> **Spec normativa:** [README.md](./README.md)

## 1. Como manter este controle

Este arquivo é a fonte de verdade do progresso global. O arquivo em `stages/`
é a fonte de verdade da execução detalhada da etapa.

Em toda mudança da iniciativa:

1. atualizar o status da etapa aqui;
2. atualizar checkboxes, evidências e log no arquivo da etapa;
3. atualizar o `Resumo do realizado` da etapa;
4. adicionar evidência ao registro global abaixo;
5. registrar decisão/desvio em `DECISIONS.md` quando aplicável;
6. atualizar `Última atualização` e o resumo cumulativo deste arquivo.

Convenção:

- `[ ]` não iniciado;
- `[~]` em andamento (texto apenas; Markdown não possui estado nativo);
- `[x]` concluído com evidência;
- item bloqueado permanece `[ ]` e recebe `BLOQUEADO:` com motivo/data.

## 2. Painel de etapas

| Etapa | Estado | Gate | Controle | Resumo atual |
|---|---|---|---|---|
| S0 — Governança, contrato e baseline | Concluída | G0 | [abrir](./stages/00-governance-contract-baseline.md) | Baseline completa, contrato v1, fixture e riscos aprovados |
| S1 — Backend read model | Concluída | G1 | [abrir](./stages/01-backend-read-model.md) | Read model bounded aprovado por testes, build, benchmark e smoke TCP |
| S2 — Eventos e comandos | Em andamento | G2 | [abrir](./stages/02-events-and-commands.md) | Evento/timeline/restart e comandos core prontos; attach/export/notify seguem abertos |
| S3 — Store e controller frontend | Não iniciada | G3 | [abrir](./stages/03-frontend-store-controller.md) | Nenhuma implementação |
| S4 — Shell, rails e responsividade | Não iniciada | G4 | [abrir](./stages/04-shell-rails-responsive.md) | Nenhuma implementação |
| S5 — Reconstrução dos painéis | Não iniciada | G5 | [abrir](./stages/05-panel-rebuild.md) | Nenhuma implementação |
| S6 — Cutover e retirada do legado | Não iniciada | G6 | [abrir](./stages/06-cutover-legacy-retirement.md) | Nenhuma implementação |
| S7 — Validação, performance e release | Não iniciada | G7 | [abrir](./stages/07-validation-performance-release.md) | Nenhuma implementação |

## 3. Gates globais

### G0 — Spec, contrato e baseline

- [x] `G0-SPEC` — Requisitos `CSW-*` revisados e aceitos.
- [x] `G0-BASE` — Baseline funcional, visual, rede e render reproduzível.
- [x] `G0-CONTRACT` — Schemas propostos compilam e cobrem todos os consumers.
- [x] `G0-RISK` — Riscos de SSE, portais, plugins e worktree têm owners.
- [x] `G0-GATE` — [Etapa S0](./stages/00-governance-contract-baseline.md) concluída.

### G1 — Backend read model

- [x] `G1-LIST` — Lista paginada, busca, filtros, grupos e contagens provados.
- [x] `G1-BOOT` — Bootstrap bounded com capabilities, badges e revisions.
- [x] `G1-RES` — Resources de Contexto/Execução/Insights/Configuração paginados.
- [x] `G1-OWNER` — Bundle filesystem continua autoridade; zero migration SQLite.
- [x] `G1-LIMIT` — Limites, ETag, coalescência e erro estruturado testados.
- [x] `G1-GATE` — [Etapa S1](./stages/01-backend-read-model.md) concluída.

### G2 — Eventos e comandos

- [ ] `G2-EVENT` — Envelope discriminado e projeção de resources implementados.
- [ ] `G2-REPLAY` — Bus/seq/revision/gap/restart aprovados.
- [ ] `G2-LOG` — Backfill/live/export do Worker Log usam uma autoridade backend.
- [ ] `G2-CMD` — Comandos tipados, revisions, idempotência e batch parcial.
- [ ] `G2-NOTIFY` — Badge, read, dismiss e dedup de notificações coerentes.
- [ ] `G2-GATE` — [Etapa S2](./stages/02-events-and-commands.md) concluída.

### G3 — Store e controller frontend

- [ ] `G3-STORE` — Store normalizada, bounded e isolada por sessão.
- [ ] `G3-RECON` — Snapshot/live/stale response/replay reconciliados.
- [ ] `G3-SELECT` — Selectors não causam render cruzado.
- [ ] `G3-CTRL` — Controller único e adapters sem regras de domínio.
- [ ] `G3-QUERY` — Query client deduplica, cancela e invalida por resource.
- [ ] `G3-GATE` — [Etapa S3](./stages/03-frontend-store-controller.md) concluída.

### G4 — Shell, rails e responsividade

- [ ] `G4-SHELL` — Um shell serve projeto/global/editor/App Studio Coder.
- [ ] `G4-REG` — Registry substitui switch e integra plugins/capabilities.
- [ ] `G4-NAV` — Navigator paginado, pesquisável e virtualizado.
- [ ] `G4-RAIL` — Seis destinos, labels, badges e teclado.
- [ ] `G4-RESP` — Desktop estreito e mobile mantêm todos os destinos acessíveis.
- [ ] `G4-PORTAL` — Nenhum loop/ref update durante commit.
- [ ] `G4-GATE` — [Etapa S4](./stages/04-shell-rails-responsive.md) concluída.

### G5 — Painéis

- [ ] `G5-SUM` — Resumo funcional.
- [ ] `G5-CTX` — Contexto funcional.
- [ ] `G5-EXEC` — Execução/Worker Log funcional.
- [ ] `G5-INS` — Insights funcional.
- [ ] `G5-CANVAS` — Preview/diagram funcional e wide.
- [ ] `G5-CONFIG` — Configuração funcional.
- [ ] `G5-STATE` — Estado visual preservado sem manter painéis pesados montados.
- [ ] `G5-I18N` — PT-BR/EN e a11y dos painéis aprovados.
- [ ] `G5-GATE` — [Etapa S5](./stages/05-panel-rebuild.md) concluída.

### G6 — Cutover e retirada

- [ ] `G6-SURF` — Todas as superfícies usam o shell novo.
- [ ] `G6-STREAM` — Um attach/store por sessão, sem dual-write.
- [ ] `G6-PREF` — Preferências antigas migradas.
- [ ] `G6-IMPORT` — Grafo de imports do legado zerado.
- [ ] `G6-DEL` — Arquivos, eventos DOM, endpoints e CSS mortos removidos.
- [ ] `G6-FLAG` — Feature flag e adapters temporários removidos.
- [ ] `G6-ROLL` — Rollback para última build nova estável documentado.
- [ ] `G6-GATE` — [Etapa S6](./stages/06-cutover-legacy-retirement.md) concluída.

### G7 — Validação e release

- [ ] `G7-UNIT` — Suítes de contrato/store/UI aprovadas.
- [ ] `G7-E2E` — Projeto/global/editor/App Studio/mobile/reconnect aprovados.
- [ ] `G7-VISUAL` — Matriz visual aprovada.
- [ ] `G7-PERF` — Budgets `CSW-PERF-001..010` aprovados.
- [ ] `G7-A11Y` — Teclado, foco, contraste e reader checks aprovados.
- [ ] `G7-BUILD` — Build, typecheck aplicável e diff check aprovados.
- [ ] `G7-RUNBOOK` — Release notes, troubleshooting e ownership atualizados.
- [ ] `G7-GATE` — [Etapa S7](./stages/07-validation-performance-release.md) concluída.

## 4. Invariantes finais

- [ ] `FINAL-01` — Um controller/store canônico por sessão.
- [ ] `FINAL-02` — Um protocolo tipado para snapshot, events e commands.
- [ ] `FINAL-03` — Zero nova persistência SQLite de rail/sessão.
- [ ] `FINAL-04` — Zero evento de domínio por `window.CustomEvent`.
- [ ] `FINAL-05` — Zero fetch de bootstrap por alternância de painel.
- [ ] `FINAL-06` — Zero render de conversa causado por evento diagnóstico.
- [ ] `FINAL-07` — Todos os lists/buffers/journals expostos são bounded.
- [ ] `FINAL-08` — Mobile e narrow têm paridade funcional.
- [ ] `FINAL-09` — Plugins continuam sandboxed.
- [ ] `FINAL-10` — Persistido/live mantém ordem e replay.
- [ ] `FINAL-11` — Legado ausente do source graph e build output.
- [ ] `FINAL-12` — Toda exceção possui ADR, owner e prazo.

## 5. Registro global de evidências

| ID | Etapa | Tipo | Commit/build | Data | Comando ou artifact | Resultado |
|---|---|---|---|---|---|---|
| CSW-E000 | S0 | documentação | worktree | 2026-08-01 | `docs/architecture/chat-session-workbench/` | Corpus inicial e trackers criados; implementação não iniciada |
| CSW-E001 | S0 | baseline | worktree | 2026-08-01 | [S0 baseline](./evidence/S0-baseline-2026-08-01.md) | Estrutura, consumers, owners e runtime live capturados |
| CSW-E002 | S0 | regressão | worktree | 2026-08-01 | 12 arquivos Vitest + `npm run build:dashboard` + `npm run typecheck` | 67 testes, build e typecheck aprovados |
| CSW-E003 | S0 | contrato | worktree | 2026-08-01 | `npx vitest run packages/api-bus/src/__tests__/coder-session-workbench.test.ts` | 12 testes aprovados; typecheck raiz aprovado; zero `unknown`/`any` no contrato |
| CSW-E004 | S0 | fixture | worktree | 2026-08-01 | `node benchmarks/session-workbench/fixture.mjs` | 1.000/10.000 sessões geradas e invariantes validadas |
| CSW-E005 | S0 | rede/render | worktree | 2026-08-01 | `session-workbench.baseline.spec.ts` | Abertura 23 requests/~1,61 MB; bursts de 500 eventos medidos; zero pageerror |
| CSW-E006 | S0 | visual | worktree | 2026-08-01 | `session-workbench.visual-baseline.spec.ts` | Matriz 1920/1440/1280/390 capturada sem erro de página |
| CSW-E007 | S0 | E2E global | worktree | 2026-08-01 | `global-session-workbench.spec.ts` | 6/6 em três viewports, incluindo A→B→A e reload/reattach |
| CSW-E008 | S0 | gate | worktree | 2026-08-01 | [controle S0](./stages/00-governance-contract-baseline.md) | G0 aprovado; S1 ativada |
| CSW-E009 | S1 | read model | worktree | 2026-08-01 | [progresso S1](./evidence/S1-read-model-progress-2026-08-01.md) | Lista paginada, cursor/revision, grupos, boundary e ETag implementados |
| CSW-E010 | S1 | regressão | worktree | 2026-08-01 | 2 arquivos Vitest + `npm run typecheck` | 16 testes e typecheck aprovados |
| CSW-E011 | S1 | bootstrap | worktree | 2026-08-01 | [progresso S1](./evidence/S1-read-model-progress-2026-08-01.md) | Bootstrap bounded, capabilities/plugins, badges discriminados, ETag/304 e coalescência implementados |
| CSW-E012 | S1 | regressão | worktree | 2026-08-01 | 2 arquivos Vitest + `npm run typecheck` | 19 testes e typecheck aprovados |
| CSW-E013 | S1 | resources | worktree | 2026-08-01 | [progresso S1](./evidence/S1-read-model-progress-2026-08-01.md) | Quatro resources lazy, cursors/revisions independentes, owners paginados e validação runtime profunda |
| CSW-E014 | S1 | regressão/performance | worktree | 2026-08-01 | 8 arquivos Vitest + benchmark HTTP + dashboard build | 50 testes; 1k/10k em 25,940/63,922 ms; build aprovado |
| CSW-E015 | S1 | concorrência | worktree | 2026-08-01 | primeira execução de `npm run typecheck` | Três referências Company/pipeline ficaram transitórias durante alteração concorrente |
| CSW-E016 | S1 | validação | worktree | 2026-08-01 | `npm run typecheck` + diff check | Typecheck aprovado; diff check do escopo sem erros |
| CSW-E017 | S1 | runtime | processo ativo | 2026-08-01 | GET `:7333/api/coder/session-workbench/sessions?scope=global&limit=1` | 404; backend ativo preservado e ainda sem o módulo novo |
| CSW-E018 | S1 | gate HTTP | worktree | 2026-08-01 | `npx tsx benchmarks/session-workbench/live-smoke.mts` + `npx tsc --noEmit --pretty false` | TCP efêmero: 400 estruturado e 200/304 em list/bootstrap/context; typecheck aprovado; G1 aprovado |
| CSW-E019 | S2 | event projection | worktree | 2026-08-01 | [progresso S2](./evidence/S2-events-progress-2026-08-01.md) | 5 arquivos/40 testes, typecheck e diff check; query/timeline, identidade, redação, filtros, ETag e restart aprovados |
| CSW-E020 | S2 | command service | worktree | 2026-08-01 | [progresso S2](./evidence/S2-events-progress-2026-08-01.md) | 4 arquivos/37 testes e typecheck; commands core, revision, receipt, duplicate retomável, invalidation e batch aprovados |
| CSW-E021 | S2 | regressão integrada | worktree | 2026-08-01 | 11 arquivos Vitest + typecheck + `npm run build:dashboard` | 72 testes, typecheck e build 6.155 módulos/8,27 s aprovados |

## 6. Resumo cumulativo do realizado

### 2026-08-01 — Especificação inicial

- Criado o corpus normativo da refatoração.
- Registradas decisões arquiteturais, contratos-alvo, UX, migração e gates.
- Criado um controle detalhado para cada etapa S0–S7.
- Nenhum código de produto foi alterado e nenhum gate de implementação foi
  aprovado.

### 2026-08-01 — Início da execução

- S0 foi marcada como etapa ativa.
- Mudanças Unity fora do escopo foram isoladas; arquivos de chat/backend/api-bus
  estavam limpos antes da iniciativa.
- Baseline estrutural e regressão foram registradas: 67 testes, build e
  typecheck verdes.
- Criado o contrato público v1 em `@mcp/api-bus`, sem campos `unknown`/`any`,
  com parsers bounded e 12 testes próprios.
- Criada fixture determinística e segura de 1.000/10.000 sessões.
- Naquele ponto, G0 ainda aguardava rede, React Profiler, recaptura visual e
  reattach; esses itens foram concluídos no corte seguinte.

### 2026-08-01 — G0 aprovado e S1 iniciada

- O backend existente em 7333 foi usado somente para leituras; Vite temporário
  em 7317 foi encerrado por PID após as capturas.
- Baseline: 23 requests/~1,61 MB na abertura, ~985 kB na Configuração e refetch
  de chapters em toda troca de painel.
- Burst de 500 eventos com Worker Log fechado gerou 0 commits/mutações; aberto,
  10 commits/518 mutation records.
- Matriz visual desktop/mobile e regressão global/reattach foram aprovadas.
- G0 foi fechado e S1 passou a ser a etapa ativa.

### 2026-08-01 — Primeiro corte S1

- Criada projeção de catálogo filesystem que pagina antes de hidratar bundles.
- Criados query service e endpoint de lista com filtros, grupos, cursor ligado
  à revision, limites, ETag e erros estruturados.
- Teste prova cinco hidratações para uma página de cinco sobre 120 entradas.
- Badges incompletos são marcados `pending`, sem contagens fabricadas.
- 16 testes e typecheck verdes; nenhuma migration SQLite adicionada.
- Runtime ativo preservado; a rota requer restart posterior para prova live.

### 2026-08-01 — Bootstrap S1

- Criada projeção bounded de bootstrap sobre owners filesystem distintos, sem
  leitura do transcript ou do runtime-event journal.
- Capabilities combinam sessão, worker pool e registry declarativo de plugins.
- Badges não carregados possuem disponibilidade discriminada, conforme
  CSW-D014; capítulos são medidos.
- Lista/bootstrap respondem ETag/304 e coalescem leituras concorrentes em mapa
  limitado a 64 chaves.
- 19 testes focados e typecheck raiz aprovados.

### 2026-08-01 — Resources S1 e aprovação de G1

- Contexto, Execução, Insights e Configuração foram implementados como resources
  discriminados e lazy, com cursor/revision/ETag por view.
- Owners filesystem de capítulos, subagentes e task runs agora oferecem páginas
  bounded; skills usam consulta metadata-only, sem carregar prompts.
- Responses são validadas profundamente no boundary; payload interno inválido
  falha fechado como `invalid_response`.
- Benchmark HTTP sobre 1.000/10.000 sessões confirmou 100 hidratações para uma
  página de 100 e response estável em ~57,8 kB.
- Tool insights deixou de materializar a conversa: a projeção streaming aplica
  rollback, pagina summaries e mantém somente agregados por nome.
- 50 testes, typecheck e build do dashboard passaram. Uma falha transitória de
  typecheck durante a retirada concorrente de pipelines foi resolvida pelo
  owner externo sem edição do Workbench nesses arquivos.
- O processo instalado continua retornando 404 porque executa o artefato em
  `Program Files`, não esta árvore; reiniciá-lo não carregaria o fonte novo.
- Um servidor TCP efêmero provou o transporte das rotas reais, envelopes e
  conditional GET sem tocar dados ou processos instalados. G1 foi aprovado e
  S2 ativada.

### 2026-08-01 — Primeiro corte S2

- O runtime journal agora preserva `busId` em eventos novos; eventos legados
  recebem identidade de dedup determinística sem migration.
- Criada projeção backend de Worker Log com categoria, severidade, redação,
  truncamento, filtros server-side e cursor bounded.
- A rota histórica usa o mesmo envelope público esperado pelo futuro tail live
  e valida respostas profundamente antes do JSON.
- A timeline lazy consome a mesma projeção e um restart simulado recompõe o
  envelope diretamente do bundle.
- 5 arquivos/40 testes, typecheck e diff check passaram; attach, export,
  notificações e comandos permanecem no escopo ativo.

### 2026-08-01 — Segundo corte S2

- Criado boundary de comandos discriminados e command service explícito para
  navigator, duplicate, tools e skills.
- Expected revision, coalescência e receipt filesystem protegem contra lost
  update e repetição; batch preserva resultado por item.
- Duplicate usa identidade determinística e replay idempotente para poder ser
  retomado depois de falha intermediária.
- Invalidation tipada é publicada somente após o receipt; respostas inválidas
  falham fechadas no HTTP boundary.
- 4 arquivos/37 testes e typecheck passaram. Notificações read/dismiss ainda
  mantêm `S2-008/009` parciais.
- A revalidação integrada passou 72 testes, typecheck e build do dashboard.

## 7. Pendências e bloqueios globais

- A instalação empacotada só receberá o Workbench no fluxo de build/release de
  S7; isso não é bloqueio do código-fonte de S2.
