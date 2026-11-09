# Implementação e evidências — estado por requisito

Atualizado em 26/10/2026 após auditoria independente. Workspace `D:\MCP`, branch `codex/remove-rust-runtime`, baseline `448d526dd2e24247617938721c0d8cf18ce850cf` (HEAD).

Este é o relatório por item exigido pelo [capítulo 07 §10](./07-implementacao-e-validacao.md). O status vem de código, teste e artefato conferidos na [auditoria](./AUDIT.md), não da autoavaliação do implementador. O relatório cronológico anterior está preservado em [IMPLEMENTATION-LOG.md](./IMPLEMENTATION-LOG.md).

**Estado:** em validação. Não houve commit, push, publicação nem troca da instalação ativa. Nenhum requisito foi validado em app instalado. Os quatro P0 da auditoria foram corrigidos em 26/10/2026, cada um com teste de regressão; essas correções também não foram commitadas.

**Candidata:**

- fonte congelada `.tmp/agent-ide-reliability/candidate-release-frozen`: 6.050 arquivos, SHA-256 `fcca272cc870fa554967845bc7a5d7d439aab4820e1e47de647ea279d14e0e37`;
- executável `candidate/win-unpacked/CodeStudio.exe`: `c15ad036…da88`;
- ASAR: `e994e7ee…daa2`.

Os artefatos ficam em `.tmp/agent-ide-reliability/`, fora do git. Esse diretório contém perfis descartáveis, então não deve ser publicado.

## 1. Resumo

| Família | Requisitos | Entregues | Parciais | Pendentes |
|---|---:|---:|---:|---:|
| IDX + MCP-09 | 13 | 0 | 13 | 0 |
| DSC | 10 | 0 | 10 | 0 |
| MCP (exceto MCP-09) | 9 | 0 | 7 | 2 |
| EXE | 12 | 0 | 12 | 0 |
| DB | 14 | 0 | 13 | 1 |
| CTR | 7 | 0 | 6 | 1 |
| **Total** | **65** | **0** | **61** | **4** |

**P0 da auditoria:** os quatro foram corrigidos em 26/10/2026, cada um com teste de regressão que falhou antes da correção ([AUDIT §4.1](./AUDIT.md#41-correções-aplicadas-em-26102026)).

- Classificador SQL: um trecho `$$…$$` ou um comentário `#` não esconde mais um statement (`read-guard.test.ts`).
- SQL Server em modo stream: o erro emitido como evento faz a consulta falhar e o batch fazer rollback (`mssql-stream.test.ts`).
- `exec_command`: o descarte de sessões tem prazo de 10 s, e o stop dos workers não trava mais (`exec-command.test.ts`).

Falta rodar, no runtime do Electron, os testes que abrem SQLite real.

**Bloqueiam a promoção:** G3 e G5 abertos; G0, G1, G2 e G4 parciais (§2).

**Ganhos com evidência sólida:**

- Busca de caminhos: em 150 mil arquivos, o p95 SQL caiu de 16 ms para 1,2 ms, e os caminhos Windows passaram a ser encontrados.
- Descoberta: o ranking de tools em português corrigido.
- SQL: os dois repros do diagnóstico são bloqueados.
- Índice: a revisão estrutural entrou na chave do cache.
- SQLite: o do usuário e o startup do interno rodam em processo filho.
- Contexto do agente: passou a incluir a configuração exportada.

**Agente:**

- Sob o verificador pré-registrado (V1), o resultado vai de 18/25 para 20/25 tarefas corretas, sem par regredido.
- Os tokens por tarefa correta caem 9,5%. A meta de 20% não foi atingida.
- O verificador V2, escrito durante a rodada, dá 22/25 e −17,7%. Esse número é análise pós-hoc (§5).

## 2. Gates

| Gate | Estado | Evidência | Pendência objetiva |
|---|---|---|---|
| G0 — diagnóstico | parcial | Baseline `448d526d`; hardware em prosa; Node e Electron no `buildEvidence` | Gravar configuração e hardware em cada execução (07 §4) |
| G1 — correção | parcial | Suíte com 11.636 ok e 33 ignorados (`workspace-tests-context-final.txt`); typecheck e boundaries refeitos na auditoria; P0 corrigidos com teste de regressão (AUDIT §4.1) | Testes com SQLite real não rodados depois das correções dos P0; `pnpm check:loc` falha; suíte ampla não reexecutada depois das mudanças de Redis |
| G2 — integração | parcial | A evidence chega ao SSE; `process-audit-final-v2.json` sem processos nem contêineres | Evidence em cancelamento e timeout; consumidor da evidence; `cleanup_incomplete` no descarte (AUDIT P1 29) |
| G3 — qualidade e performance | aberto | Latências de busca dentro das metas; 18/25 → 20/25 sem par regredido (V1) | Meta de custo; A/B intercalado; ≥30 jornadas com baseline; holdout independente |
| G4 — produto | parcial | Executável empacotado com UI offline e identidade fictícia (`desktop-canary-1793022784775`) | Instalador e app instalado; login OAuth; jornadas do agente dentro do app |
| G5 — recuperação | aberto | Upgrade 270 → 273 e restauração de backup em runtime de fonte | Upgrade no build final com DBs por projeto; crash no empacotado; rollback do app |

## 3. Estado por requisito

Valores: `sim`, `parcial`, `não`, `n/a` e `not_run`. "Empacotado" significa o executável candidato `win-unpacked` com perfil descartável. Os artefatos são relativos a `.tmp/agent-ide-reliability/`. Os testes são citados pelo nome do arquivo. Os números "AUDIT P1 n" remetem à [tabela de achados P1](./AUDIT.md#5-achados-p1).

### 3.1 Indexação e recuperação

| ID | Implementado | Testado | Medido | Empacotado | Status | Pendência |
|---|---|---|---|---|---|---|
| IDX-01 | parcial: ack só após o commit (`project-index/service.ts:403,457,461`) | parcial: `project-index-service.test.ts` em memória, sem falha injetada | não | não | parcial | Erro de arquivo bloqueia a publicação; journal síncrono no main (AUDIT P1 2–3) |
| IDX-02 | parcial: journal `structural_dirty` com CAS por versão (`store/src/db/structural-state.ts:15`); sem lease | parcial: `271-structural-state.test.ts`, só no store | não | não | parcial | Lease; teste de restart com pendência |
| IDX-03 | sim: revisão incrementada por trigger na mesma transação; revisão na chave do cache (`hybrid.ts:434,578`); `PRAGMA data_version` entre conexões (`store/src/db.ts:335-339`) | sim (unitário): `hybrid-cache-revision`, `271-structural-state`, `structural-generation`, `project-db-integration` | não | parcial: a revisão muda após restart no canário | parcial | Jornada busca → save → mesma busca |
| IDX-04 | parcial: `coverage` e `freshness` no grep; `completeness` heurística nos paths | parcial: `truncation-metadata.test.ts` | n/a | parcial: `freshGrep.coverage` no canário | parcial | A UI mostra ausência (AUDIT P1 1) |
| IDX-05 | sim: índice e disco sempre varridos (`live-grep.ts:31-47`; `text-grep.ts:99-102`) | parcial: só no IDE (`text-grep.test.ts`) | n/a | parcial: arquivo novo encontrado no canário | parcial | Regressão em `grep_code` (AUDIT P1 8) |
| IDX-06 | parcial: worker de grep com prazo e limites (`services/bounded-grep.ts`); o grep do IDE carrega `listFiles` inteiro | parcial: `bounded-grep.test.ts` | parcial: SQL de paths em 150 mil com p95 1,2 ms; trabalho examinado não medido | não | parcial | Teto de arquivos e bytes; staging de 2 GiB (AUDIT P1 4) |
| IDX-07 | parcial: signal até o worker vetorial; grep do IDE sem signal; abort no rerank global vira sucesso | parcial: `hybrid-cache-revision`, `hyde` | não | não | parcial | AUDIT P1 7 |
| IDX-08 | parcial: realpath dentro da raiz; `project_id` em paths, journal e cache; disco lido com `dot: true` | parcial: `bounded-grep.test.ts` | sim: projeto errado com neg=1 | não | parcial | Escopo de dotfiles (AUDIT P1 5) |
| IDX-09 | parcial: `structuredContent` com revisão, path, linha e hash; sem revalidação na leitura | parcial: `semantic-search-delegation.test.ts` | n/a | parcial: `mcpPathHints=passed` | parcial | Revalidar hash e revisão |
| IDX-10 | sim: harness com denominador real; reranker automático não promovido | sim: `engine`, `semantic-profile-runtime`, `hybrid-pipeline` | parcial: metas atingidas no corpus diagnóstico (§5) | n/a | parcial | Ganho fora do ajuste não demonstrado (AUDIT P1 9) |
| IDX-11 | parcial: paths, símbolos e texto em paralelo; falha exibida como vazio; política API × MCP diverge | parcial: e2e com API mockada | sim: p95 162,7 / 171,5 ms | parcial: busca de arquivo novo na UI offline | parcial | Falha distinta de vazio; política única |
| IDX-12 | n/a: migrações 271–273 só para frente | parcial: script de upgrade só no DB central | sim: 270 → 273 em fonte, antes do código final | parcial: canário frio e reabertura; sem upgrade no empacotado | parcial | AUDIT P1 6 |
| MCP-09 | sim: `coverage`, `freshness`, revisão e `absenceConclusive:false` | parcial: falta zero hits com cobertura parcial | n/a | sim: `mcpPathHints=passed` | parcial | Teste do caso parcial |

### 3.2 Descoberta e MCP

| ID | Implementado | Testado | Medido | Empacotado | Status | Pendência |
|---|---|---|---|---|---|---|
| DSC-01 | parcial: primitivas compartilhadas por `find_tools` e catálogo; `expand_toolset` resolve por tier | não | parcial: 160/160 estados, com consulta igual ao nome exato | não | parcial | Serviço único e teste de equivalência |
| DSC-02 | sim: `promoteTool` recusa tools bloqueadas e só altera pins; o dispatch revalida | parcial: casos bloqueados em `find-tools` e `capability-catalog-tool` | sim: 40 bloqueadas sem ativação | não | parcial | Guarda do runner sem teste |
| DSC-03 | parcial: nome exato primeiro; sem alias exato por capacidade | não | sim: top-1 1,0 de 100 a 10 mil descritores | não | parcial | Teste do critério |
| DSC-04 | parcial: NFKD, stopwords PT e mapa PT→EN global | sim: `find-tools-score.test.ts` | parcial: PT 1,0 (baseline top-1 0,81), com consultas derivadas da mesma tabela | não | parcial | Aliases por capacidade; IDF |
| DSC-05 | sim: margem de ambiguidade e cobertura (`find-tools.ts:203-209`) | não | não | não | parcial | Medir autoativação errada ≤1% |
| DSC-06 | parcial: receipt calculado da projeção final antes do `provider.chat`; formato diferente de `ActivationReceiptV2` | parcial: `tool-projection.test.ts`, função pura | parcial: fixture tautológica | não | parcial | AUDIT P1 14 |
| DSC-07 | parcial: `toolLimits` no provider; só a OpenAI oficial declara `maxNameChars` | parcial: `tool-limits.test.ts`, 2 de 3 decorators | não | não | parcial | AUDIT P1 12–13 |
| DSC-08 | parcial: catálogo limitado; `list_tools` devolve tudo | parcial | n/a | não | parcial | AUDIT P1 15 |
| DSC-09 | sim: cache por registry selado | não | sim: p95 ≤1,2 ms em 2.000 descritores, ranking puro | não | parcial | Teste de invalidação |
| DSC-10 | parcial: chamadas legadas preservadas; sem evento de uso legado | parcial | não | não | parcial | Evento de compatibilidade |
| MCP-01 | parcial: `nextCursor` com limites, detecção de ciclo e dedupe; uma falha descarta a fonte | parcial: `mcp-catalog-pagination.test.ts` | n/a | não | parcial | Cache do SDK por página (AUDIT P1 10) |
| MCP-02 | parcial: concorrência global de 4; a publicação espera a fonte mais lenta | não | não | não | parcial | AUDIT P1 18 |
| MCP-03 | não no produto: o pool faz rebuild total | parcial: caminho sem chamador | não | não | pendente | AUDIT P1 11 |
| MCP-04 | sim (baseline): handler preso ao `configKey`; revisão por tool | sim (baseline) | n/a | não | parcial | O rebuild total reemite as revisões |
| MCP-05 | sim: adaptador comum (`mcp-result.ts`) no bridge interno e no externo | parcial: `mcp-result.test.ts` | n/a | parcial: smoke empacotado | parcial | Fixture de worker e nested |
| MCP-06 | parcial: unknown sem replay (baseline) | parcial (baseline) | n/a | não | parcial | AUDIT P1 17 |
| MCP-07 | sim (baseline): externos sem paralelismo nem relaxamento de postura | parcial (baseline) | n/a | não | parcial | Nada novo nesta entrega |
| MCP-08 | parcial: bytes medidos depois do parse | parcial | não | não | parcial | AUDIT P1 16 |
| MCP-10 | não: nenhuma fixture nova | parcial (baseline) | n/a | parcial: paridade do catálogo interno | pendente | Fixtures de versão, formato legacy e capacidades ausentes |
| Contexto do agente (sem ID) | sim: constantes exportadas e paths sem símbolo entram no mapa | sim: `repo-map.test.ts`, vermelho → verde | sim: `context-v4` com 7/10 contra 3/10 | sim: `configurationRepoMap=passed` | entregue | Qualquer arquivo sem símbolo disputa o orçamento |

### 3.3 Execução

| ID | Implementado | Testado | Medido | Empacotado | Status | Pendência |
|---|---|---|---|---|---|---|
| EXE-01 | parcial: a autoridade nested já existia; o novo é o prazo nested limitado pelo saldo do pai | parcial: só testes pré-existentes | n/a | não | parcial | AUDIT P1 20 |
| EXE-02 | parcial: `invoke` devolve `data` sem parse; não documentado | não | n/a | não | parcial | AUDIT P1 30 |
| EXE-03 | sim: processo descartável com watchdog externo, já como padrão | parcial: spin síncrono e pós-await; loop de microtasks não | parcial: `postAwaitSpin=contained`; custo não medido | sim: `packaged-runtime-final` e `packaged-runtime-release-v2` | parcial | AUDIT P1 21–23 |
| EXE-04 | parcial: 16 MiB por direção, 128 RPC, 50 chamadas, heap de 128 MiB | não | não | não | parcial | AUDIT P1 30 |
| EXE-05 | parcial: gate e lanes do baseline; unknown bloqueia | parcial: testes pré-existentes | não | não | parcial | Scheduler por domínio de recurso |
| EXE-06 | parcial: `CommandSpec` com argv e shell | não | n/a | not_run | parcial | AUDIT P1 26–27 |
| EXE-07 | parcial: owner, admissão de 16 sessões, reaper, dispose por árvore e descarte com prazo de 10 s | parcial: `exec-command.test.ts` › descarte com transporte que nunca fecha; os demais caminhos novos sem teste | não | parcial: grupo POSIX chamado direto | parcial | P0-4 corrigido (AUDIT §4.1); AUDIT P1 29 |
| EXE-08 | parcial: `poll_session` como leitura; `stop_session` com recibo | não | n/a | not_run | parcial | AUDIT P1 28 |
| EXE-09 | parcial: spool com corte UTF-8, cursor por owner e TTL | sim (unitário): `process-output.test.ts` | n/a | parcial: spool chamado direto no smoke | parcial | AUDIT P1 24–25 |
| EXE-10 | parcial: `max_output_chars` e o alias legado concordam | parcial | n/a | not_run | parcial | Shell efetivo e códigos no resultado |
| EXE-11 | parcial: só o spool se recupera após restart | parcial: restart do spool | n/a | não | parcial | AUDIT P1 32 |
| EXE-12 | parcial: avaliador embutido; grupo de processos POSIX | n/a | n/a | parcial: Windows só com avaliador e spool; POSIX a partir da fonte | parcial | `exec_command` no executável; PTY; SSH |

### 3.4 Database

| ID | Implementado | Testado | Medido | Empacotado | Status | Pendência |
|---|---|---|---|---|---|---|
| DB-01 | parcial: um lexer com 16 interpretações conservadoras (escape por barra, `--` e `#` do MySQL, dollar-quote do PostgreSQL), sem receber o engine | parcial: `read-guard.test.ts` com os repros da spec e os bypass de `$` e `#`; sem corpus por engine | n/a | não | parcial | P0-1 e P0-2 corrigidos (AUDIT §4.1); corpus adversarial por engine |
| DB-02 | parcial: chave com projeto no pool, no catálogo e nos jobs; sem revisão | parcial: `jobs.test.ts`, só recibos | n/a | não | parcial | AUDIT P1 41 |
| DB-03 | parcial: janela de 4 MiB e 64 KiB por célula; pg-cursor; MySQL e MSSQL sem parada antecipada | parcial: `integration.mongo-redis.test.ts` | sim (PG): 200 de 201 linhas, 206.892 bytes retidos | parcial: SQLite no canário | parcial | AUDIT P1 39 |
| DB-04 | parcial: prazo único; canal de cancelamento próprio; nova checagem antes de cada statement e do commit | parcial: `sqlite-process.test.ts` | parcial: 3 cancelamentos em 223 ms | parcial: cancelamento SQLite | parcial | AUDIT P1 33–34 |
| DB-05 | parcial: rastreador de outcome de batch; erro do SQL Server em modo stream faz a consulta falhar | parcial: `batch-outcome.test.ts`, `flow.test.ts`, `mssql-stream.test.ts` | n/a | não | parcial | P0-3 corrigido (AUDIT §4.1); AUDIT P1 43 |
| DB-06 | parcial: leases; o sweeper respeita uso ativo; sem revisão monotônica | não | n/a | não | parcial | AUDIT P1 38 |
| DB-07 | parcial: catálogo por nomes com keyset e cursor assinado; `schemaSnapshot` ainda integral | parcial: `catalog-export.test.ts` com 205 tabelas | não, sem fixture de 10 mil tabelas | parcial: 1 tabela no canário | parcial | AUDIT P1 35 |
| DB-08 | não: sem `DbCapabilities` | parcial | n/a | não | pendente | AUDIT P1 40 |
| DB-09 | parcial: edição checada com a PK completa | parcial: conflito real em SQLite | n/a | não | parcial | Regressão do grid (AUDIT P1 36) |
| DB-10 | parcial: keyset, jobs duráveis, import limitado e UI de jobs | parcial: `jobs.test.ts`, `database-job-store.test.ts` | n/a | não | parcial | AUDIT P1 37 |
| DB-11 | parcial: quoting com schema; batch read-only numa sessão fixa | não | n/a | não | parcial | AUDIT P1 42 |
| DB-12 | sim: SQLite do usuário e startup do SQLite interno em processo filho | sim: `sqlite-process.test.ts` | não: lag do main não medido | sim: cancelamento, reopen e UI SQLite | parcial | Medir a responsividade do main |
| DB-13 | parcial: estágios em PG, MySQL e SQLite; os demais drivers só medem o total | sim: `query-timing.test.ts` | sim: aquisição 13,2 ms, execução e fetch 193,2 ms | parcial | parcial | Estágios por engine; exibir na UI |
| DB-14 | parcial: unknown no agente (baseline); recibos duráveis | parcial | n/a | não | parcial | P0-1 corrigido no classificador (AUDIT §4.1); `withReconnect` sem teste |

### 3.5 Contratos e observabilidade

| ID | Implementado | Testado | Medido | Empacotado | Status | Pendência |
|---|---|---|---|---|---|---|
| CTR-01 | parcial: versão 2 e UUID por invocação; `parentInvocationId` no nested; IDE e API sem contexto | parcial: `invocation-evidence.test.ts` | n/a | não | parcial | Golden fixtures; o reuso do lote copia o ID de outra chamada |
| CTR-02 | parcial: revisões de catálogo e de autorização apenas gravadas; as revisões de dados invalidam caches | parcial | n/a | parcial | parcial | AUDIT P1 47 |
| CTR-03 | parcial: limites por domínio; sem orçamento hierárquico | sim, nas frentes | sim: DB grande | parcial | parcial | Orçamento hierárquico (06 §5) |
| CTR-04 | parcial: prazo absoluto só com `toolTimeoutMs>0` e no nested | não | parcial | parcial | parcial | AUDIT P1 46 |
| CTR-05 | parcial: `unknown` prevalece e o truncamento marca parcial; caminhos críticos saem sem evidence | parcial | n/a | não | parcial | AUDIT P1 45 |
| CTR-06 | não: allowlist sem sink; a telemetria persiste argumentos e resultados | parcial: sentinelas só no evento novo | n/a | não | pendente | AUDIT P1 44 |
| CTR-07 | parcial: direto e nested pelo mesmo wrapper | parcial | n/a | não | parcial | Matriz diferencial direto, nested, API e UI |

## 4. Backlog B00–B22

| Item | Gate de saída (07 §2) | Estado | O que falta |
|---|---|---|---|
| B00 | Manifesto reproduzível, corpus separado do ajuste | parcial | Harness fora do hash; holdout não independente; configuração por execução |
| B01 | Repros bloqueados antes do dispatch; regressão por dialeto | parcial | Corpus adversarial por engine. Os bypass de `$` e `#` foram corrigidos com teste (AUDIT §4.1) |
| B02 | Zero falso rollback; falhas antes, durante e depois do commit diferenciadas | parcial | Injeção de falha por fase; SQL Server real. O falso `committed` do SQL Server foi corrigido com teste (AUDIT §4.1) |
| B03 | Crash e erro transiente não perdem delta | parcial | Lease; teste de falha; erro de arquivo bloqueia a publicação |
| B04 | Save, delete, rename e branch invalidam só a revisão afetada | parcial | Jornada com DB real |
| B05 | Todas as páginas válidas; loop, erro e cancelamento limitados | parcial | Cache do SDK; catálogo parcial |
| B06 | Paridade produtor → bridge → worker → direto e nested | parcial | Fixture de worker e nested |
| B07 | Nunca prometer tool ausente; configuração impossível falha antes do provider | parcial | Receipt; erro não-retryable; subagentes |
| B08 | Término físico e cauda provados; quota preserva sessões | não passou | Testes dos caminhos novos; prova de término físico e de cauda. O descarte sem prazo foi corrigido com teste (AUDIT §4.1) |
| B09 | IDs iguais com split central e por projeto | não passou | Teste inexistente |
| B10 | Loop pós-await contido; launcher empacotado; custo medido | parcial | Custo não medido |
| B11 | Arquivo novo com hit antigo, ou cobertura parcial explícita | parcial | Teste no MCP; a UI ignora a cobertura |
| B12 | p95 e trabalho examinado melhoram; a UI não recebe o universo de arquivos | parcial | Trabalho examinado não medido |
| B13 | Exato top-1; ambiguidades não ativam; gold set passa | parcial | Ambiguidade não medida |
| B14 | Fonte B não derruba A | não passou | MCP-03 fora do produto |
| B15 | Testes diferenciais e mesmo outcome e policy | não passou | Política de outcome diverge entre direto e nested |
| B16 | Windows e POSIX, Unicode, cursor, quota e recovery | parcial | `CommandSpec` sem teste; `exec_command` não rodou no empacotado |
| B17 | Saturação, rotação e schema homônimo corretos | parcial | Revisão; fila de aquisição; teste de schema homônimo |
| B18 | Memória proporcional à página; main responsivo | parcial | MySQL e MSSQL sem parada antecipada; lag não medido |
| B19 | 10 mil tabelas sem introspecção total | parcial | Não medido |
| B20 | Ganho útil demonstrado; nenhuma regressão exata | parcial | Ganho fora do ajuste |
| B21 | Edição concorrente detectada; PK composta; consistência declarada | parcial | PK temporal; o grid desliga a edição com células objeto |
| B22 | Evidência no mesmo build; não apagar dados nem sessões | parcial | Upgrade no build final; instalador |

## 5. Medições consolidadas

Hardware: Ryzen 9 7950X3D com 32 threads lógicas e ~95 GiB de RAM, Windows 10.0.26300, Electron 42.5.0 com ABI 146. Rodadas simultâneas podem ter aumentado latências.

| Medição | Artefato | Resultado | Meta (07 §6) | Ressalva |
|---|---|---|---|---|
| Busca de caminhos na IDE, da tecla ao resultado | `ide-path-latency-1440x900-dark.json` | p95 162,7 ms em 10 mil arquivos e 171,5 ms em 150 mil; 200 amostras cada | p95 ≤250 ms médio e ≤500 ms grande | Uma classe de consulta; ponte HTTP do Playwright; exclui auth e IPC. A primeira rodada falhou por timeout (`ide-latency-final.txt`) |
| SQL de busca de caminhos | `quality/summary.json` | 150 mil arquivos: p95 1,2 ms (baseline 16 ms); caminhos Windows com recall 0 → 1 | — | Exclui o renderer |
| Busca semântica na IDE | `ide-semantic-latency-1440x900-dark-lexical-v2-no-rerank.json` | p95 600,8 ms em EN e 569,6 ms em PT; resultado útil no top 10 do aceite: 0,906 EN e 1,0 PT; pico EN de 18.169,9 ms | p95 ≤1,5 s; Recall@10 ≥90% | 80 consultas × 5 repetições; corpus sintético de 10 mil arquivos; o conjunto de ajuste PT dá 0,625, abaixo do aceite |
| Ablação de recuperação | `retrieval-1792954616464/summary.json` | Recall FTS 0,6875, híbrido 0,96875, com rerank 0,953; conceitual 0,375 / 0,9375 / 0,906 | Ganho sobre o lexical | 200 consultas sobre 40 arquivos; anterior ao léxico e às últimas mudanças do híbrido |
| Holdout semântico | `semantic-holdout-1792962577747/report.json` | Modo auto 40/40 em todas as classes; FTS em PT 37/40 e 40/40 nas demais | — | Não é independente: escrito depois do léxico, com os mesmos alvos e 39 de 40 consultas PT usando palavras do léxico |
| Ranking de descoberta | `quality/summary.json` | Aceite com top-1, recall e MRR iguais a 1,0 de 100 a 10 mil descritores; p95 5,1 ms em 10 mil. Baseline em PT: top-1 0,81 | Top-1 100%; Recall@5 ≥95%; MRR@5 ≥0,85; p95 ≤50 ms em 2.000 | Ranking puro; exclui autorização e ativação; sem classe ambígua |
| Estados de descoberta | `discovery-state.json` | 200 de 200 estados | 100% dos receipts iguais à projeção | O conjunto enviado é montado pelo próprio script |
| Consulta grande em PostgreSQL | `database-performance.json` | 200 retornadas de 201 observadas; 206.892 bytes retidos (teto 4 MiB, 64 KiB por célula); 3 cancelamentos em 223 ms; p95 morno 88 ms; lag do host p95 20 ms | No máximo 2 páginas retidas; cancelamento p95 ≤2 s; lag <50 ms | Uma amostra; sem fila de aquisição; PG local |
| Upgrade | `upgrade-1792955740496/report.json` | 270 → 273, restart, leitura pela versão antiga, backup restaurado para 270; integridade ok | G5 | Runtime de fonte, só DB central, antes do código final |
| Startup do app empacotado | `desktop-canary-1792966972233`, `-1792967056393` e `-1793022784775` | Frio 6.261 ms e morno 2.719 ms no build final; 4.719 ms na UI offline | — | Amostras únicas, não p95 |

**Agente GLM 5.3/Z.ai: 5 jornadas integradas × 5 repetições**

Artefatos: `release-benchmark-summary-v2.json` e `baseline-verifier-v2.json`. A coluna V1 foi recalculada a partir do campo `verificationV1` preservado nesses artefatos.

| Métrica | Baseline | Candidata, V1 (primário) | Candidata, V2 (pós-hoc) |
|---|---:|---:|---:|
| Tarefas corretas | 18/25 | 20/25 | 22/25 |
| Corretas e eficientes | 17/25 | 19/25 | 21/25 |
| Explore | 0/5 | 0/5 | 2/5 |
| Plan | 3/5 | 5/5 | 5/5 |
| Invoice, badge e admin | 15/15 | 15/15 | 15/15 |
| Tokens totais | 903.249 | 908.603 | 908.603 |
| Tokens por tarefa correta | 50.180,5 | 45.430,2 (−9,5%) | 41.300,1 (−17,7%) |
| Custo estimado por tarefa correta | US$ 0,0718 | US$ 0,0650 (−9,4%) | US$ 0,0591 (−17,7%) |
| Chamadas de tool executadas | 103 | 102 | 102 |
| Erros de tool (todos `submit_plan` recusado pelo harness) | 5 | 5 | 5 |
| Tempo mediano / p95 | 51.657 / 203.007 ms | 28.357 / 40.361 ms | 28.357 / 40.361 ms |

Ressalvas da tabela:

- Baseline e candidata não foram intercalados, e as cargas concorrentes diferem. A diferença de latência não é atribuível à mudança.
- O corpus foi usado no diagnóstico e não é um holdout.
- O custo usa preço fixo de 1,4 e 4,4 USD por milhão de tokens, sem desconto de cache. É uma estimativa, não fatura.
- O primeiro snapshot, com 30 cenários × 5 (`agent-benchmark-summary.json`), reprovou: 18/25 contra 15/25 nos pares, −12 pontos. Esse resultado está preservado.

## 6. Matriz de engines e plataformas

| Engine ou plataforma | Evidência real | Não executado |
|---|---|---|
| PostgreSQL 17 | `postgres-integration.txt`: 8 ok e 6 ignorados, com testes inalterados, antes da última edição do driver; `database-performance.json` | Fila de aquisição, batch abortado, schema homônimo, células grandes |
| MariaDB 10.11 | `mariadb-integration.txt`: 6 ok e 8 ignorados, com testes inalterados, antes da última edição do driver | Streaming, DDL com commit implícito, conexão de controle |
| SQLite | Testes `flow`, `catalog-export` e `sqlite-process`; `packaged-runtime-release-v2`; UI no canário offline | — |
| MongoDB 7.0 | `integration-mongo-redis.txt`: 4 testes reais | Cancelamento em voo; `$out` e `$merge` |
| Redis 7.4 | `integration-mongo-redis.txt` (3) e `redis-preview-tests.txt` (4 reais); 3 testes Playwright com IPC mockado | Memória do comando raw e do SCAN |
| SQL Server | Só o teste de regressão do modo stream, com emissor simulado (`mssql-stream.test.ts`) | Tudo contra servidor real |
| Oracle | nenhuma | Tudo |
| Windows, executável empacotado | Avaliador do code_exec, spool e SQLite filho (`packaged-runtime-release-v2`); UI offline (`desktop-canary-1793022784775`) | `exec_command` com pipe e PTY; instalador |
| Linux | `posix-runtime/report.json`: grupo de processos com Node 24.21 em contêiner, a partir da fonte | Executável distribuído |
| SSH e adapters remotos | nenhuma | Tudo |

## 7. Pendências para fechar a entrega

1. Rodar no runtime do Electron os testes que abrem SQLite real, para validar as correções dos quatro P0 ([AUDIT §4.1](./AUDIT.md#41-correções-aplicadas-em-26102026)). Os P0 já foram corrigidos com teste de regressão, mas esses testes ainda não rodaram depois das correções.
2. Fechar os P1 com teste ([AUDIT §5](./AUDIT.md#5-achados-p1)). Começar pelos que afetam correção ou escopo:
   - dotfiles no grep;
   - ausência falsa na UI;
   - cache de validadores do SDK MCP;
   - limite do provider tratado como erro transitório;
   - edição do grid desligada;
   - `db_schema` sem schema;
   - telemetria persistida com argumentos e resultados.
3. Refazer a medição do agente com o método do 07 §4–§6:
   - verificador pré-registrado;
   - A/B intercalado;
   - ≥30 jornadas com baseline;
   - holdout escrito antes do ajuste e com alvos novos;
   - harness incluído no hash da fonte.
4. Release:
   - gerar o instalador;
   - fazer o upgrade 270 → 273 com DBs por projeto no executável final;
   - exercitar crash e rollback do app;
   - fazer a jornada autenticada com login OAuth, que depende do usuário.
5. Executar SQL Server, Oracle, PTY e os adapters remotos, ou registrar formalmente a exclusão de escopo.
6. Dividir `packages/services/src/services/project-index/service.ts` para o `pnpm check:loc` voltar a passar.
7. Commitar o grupo de correções dos gates do baseline separadamente ([AUDIT §8.1](./AUDIT.md#81-correções-de-gates-quebrados-no-baseline)). A proposta de commits está em [AUDIT §9](./AUDIT.md#9-proposta-de-commits-não-executada).

## 8. Reprodução e encerramento

**Checks leves:**

```bash
pnpm typecheck
```

```bash
pnpm run check:boundaries
```

```bash
pnpm check:loc
```

```bash
git -c core.fsmonitor=false -c core.untrackedCache=false status --short -uall
```

**Testes:**

- `node scripts/test-workspace.mjs` roda a suíte ampla: Electron para SQLite e Node real para as fixtures de processo. Com `--quick`, roda só os fluxos críticos.
- Para um arquivo isolado com SQLite, use `ELECTRON_RUN_AS_NODE=1` com o executável do Electron e `node_modules/vitest/vitest.mjs run <arquivo>`.
- Não recompile dependências nativas para corrigir um falso negativo de ambiente.

**Scripts de avaliação** (todos untracked, em `scripts/`):

| Script | Uso |
|---|---|
| `bench-agent-ide-reliability.ts` | Qualidade e latência de paths e ranking (`quality/`) |
| `bench-agent-retrieval.ts` | Ablação local sobre corpus autoral descartável |
| `bench-agent-semantic-holdout.mjs` | Holdout semântico |
| `bench-agent-discovery-state.ts` | Matriz de estados de descoberta; não executa tools |
| `bench-agent-database.ts` | Apenas PostgreSQL local descartável |
| `bench-agent-reliability-live.ts` e `bench-agent-reliability-supervised.mjs` | GLM 5.3 em perfil isolado. Gera custo, então exige orçamento registrado antes. Copia a credencial autorizada para o perfil, o que exige a auditoria de limpeza |
| `summarize-agent-reliability.mjs <manifest.json>` | Consolida só os checkpoints nomeados no manifesto |
| `regrade-agent-config-verifier.mjs <entrada> <saída>` | Reavaliação offline, preservando o resultado original |
| `verify-agent-reliability-upgrade.ts` | Upgrade em perfil descartável (Electron e tsx; `RELIABILITY_BASELINE`, `RELIABILITY_PROFILE`, `RELIABILITY_SOURCE`) |
| `release/reliability-smoke.cjs` | Componentes no executável candidato com `ELECTRON_RUN_AS_NODE=1` |
| `release/reliability-desktop-canary.mjs` | App empacotado completo; `RELIABILITY_OFFLINE_UI=1` usa a UI com identidade fictícia |
| `release/reliability-posix-smoke.mjs` | Contêiner Linux próprio |
| `reliability-profile-cleanup.cjs` | Limpeza dos perfis de avaliação informados |

**Encerramento de uma rodada:**

- Confirmar que não sobrou nenhum PID próprio.
- Remover as chaves copiadas para os perfis descartáveis, com `secure_delete` e checkpoint do WAL.
- Parar só os contêineres com o label `codex.task=agent-ide-reliability`. Não parar a VM do Podman nem processos alheios por nome.
- Não publicar `.tmp/` com credenciais.
- A última auditoria registrou 116 perfis limpos, nenhuma credencial residual e nenhum processo ou contêiner ativo (`profile-cleanup-final-v2.json`, `process-audit-final-v2.json`).
