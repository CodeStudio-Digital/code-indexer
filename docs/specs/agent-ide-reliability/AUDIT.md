# Auditoria independente da implementação

**Data:** 26/10/2026. **Baseline:** `448d526dd2e24247617938721c0d8cf18ce850cf`, que continua sendo o HEAD (nada foi commitado). **Branch:** `codex/remove-rust-runtime`.

**Escopo:** as 185 modificações e os 99 arquivos novos do working tree, comparados com os 65 requisitos obrigatórios (IDX, DSC, MCP, EXE, DB, CTR), o backlog B00–B22 e os gates G0–G5 desta spec. O estado consolidado por requisito está em [IMPLEMENTATION.md](./IMPLEMENTATION.md). A narrativa original do implementador está preservada em [IMPLEMENTATION-LOG.md](./IMPLEMENTATION-LOG.md).

## 1. Resultado

- Nenhum dos 65 requisitos fica entregue nos quatro eixos: implementado, testado, medido e validado no app. São 61 parciais e 4 pendentes (MCP-03, MCP-10, DB-08 e CTR-06). Nada foi validado em app instalado.
- Há quatro achados P0. O P0-1 é uma regressão introduzida pela mudança e foi confirmado por execução. Os demais foram confirmados por leitura de código e depois reproduzidos em teste unitário. **Os quatro foram corrigidos em 26/10/2026, depois da auditoria**, cada um com um teste de regressão que falhou no código anterior e passa no corrigido (§4.1). As correções não foram commitadas, e os testes que abrem SQLite real ainda não rodaram depois delas.
- A tabela "Implementação por frente" do relatório original apresentava prova para os 65 requisitos. A auditoria encontrou prova parcial na maioria e alegações sem prova em várias linhas (§7).
- G3 e G5 estão abertos. G0, G1, G2 e G4 estão parciais.
- No benchmark do agente, o verificador pré-registrado (V1) dá 18/25 → 20/25 tarefas corretas, sem par regredido. Os tokens por tarefa correta caem 9,5% e os tokens totais sobem 0,59%. Os números 22/25 e −17,7% vêm do verificador V2, escrito durante a rodada final depois de observadas as falhas (§5, item 48).
- Melhorias com evidência sólida:
  - busca de caminhos: em 150 mil arquivos, o p95 SQL caiu de 16 ms para 1,2 ms, e caminhos Windows passaram de recall 0 para 1;
  - ranking de descoberta em português;
  - os dois repros SQL da spec agora são bloqueados;
  - a revisão estrutural entrou na chave do cache;
  - o SQLite do usuário e o startup do SQLite interno rodam em processo filho;
  - o contexto do agente passou a incluir a configuração exportada.

## 2. Método e limites

1. Inventário completo com `git -c core.fsmonitor=false -c core.untrackedCache=false status --short -uall`. O `git status` padrão deste repositório omite arquivos novos: mostrou 42 e depois 87 dos 99.
2. Cinco auditorias somente leitura, uma por frente, cruzando requisito, código, teste e artefato.
3. Checks leves executados pelo auditor: typecheck, boundaries, LOC, `git diff --check`, resolução de cada caminho citado e conferência dos números contra os artefatos.
4. Conferência direta dos P0 e dos P1 de maior impacto. A coluna "Verificação" indica o nível:
   - **execução**: função pura executada pelo auditor;
   - **código**: linha lida pelo auditor;
   - **frente**: apenas a auditoria da frente.

Limites:

- A suíte ampla não foi reexecutada.
- Nenhum build, app ou banco foi executado.
- SQL Server, Oracle, PTY e os adapters remotos não têm evidência real.
- Os P0 de código descrevem caminhos de falha, não incidentes observados.

## 3. Checks transversais

| Check | Resultado nesta auditoria | Relatório original |
|---|---|---|
| Inventário | 185 modificados + 99 novos; HEAD = baseline | Sem contagem |
| `pnpm typecheck` (backend + dashboard) | Passa, 0 erros | Confere |
| `pnpm run check:boundaries` | Passa: 862 ativas, 272 removíveis, 0 novas | Confere |
| `pnpm check:loc` | **Falha**: `packages/services/src/services/project-index/service.ts` tem 515 linhas e o teto é 500 | Não mencionado |
| `git diff --check` | Passa | Confere |
| Arquivos novos de código | Todos com ≤155 linhas, exceto `scripts/release/reliability-desktop-canary.mjs` (204) | — |
| Caminhos de evidência citados | Todos existem, exceto `quality/metrics.json`, cujo arquivo real é `quality/metrics.jsonl`. Um teste é citado só pelo nome. O caminho da identidade fictícia dentro do perfil descartável não existe mais porque o perfil foi limpo. | — |
| Números citados | Conferem com os artefatos: suítes 11.634/31 e 11.636/33, as 150 tentativas do 1º snapshot, benchmarks de busca, holdout, upgrade e DB, e a limpeza de perfis | — |

## 4. Achados P0

Os locais e as linhas desta tabela descrevem o código no momento da auditoria. As correções aplicadas depois estão em §4.1.

| # | Req. | Local | Achado | Verificação | Ação proposta |
|---|---|---|---|---|---|
| P0-1 | DB-01, DB-14 | `packages/db-drivers/src/sql/read-guard.ts:37-44` | **Regressão.** `SELECT 1 AS a$$; DELETE FROM audit_fixture; SELECT 1 AS b$$` passa a ser classificado como leitura de um único statement; o classificador do baseline bloqueava esse texto. No SQLite, `sqlite.ts:66-67` reexecuta com `db.exec` quando o prepare recusa vários statements, então o `DELETE` roda em qualquer conexão que não seja read-only. No agente, uma leitura não passa por fence nem por aprovação. | execução (classificador atual e do baseline) | Exigir fronteira de identificador antes de `$tag$`; tirar o fallback `exec` do caminho de leitura; criar um corpus adversarial por dialeto |
| P0-2 | DB-01 | `packages/db-drivers/src/sql/read-guard.ts` | `#` do MySQL não é tratado como comentário. Um `#` seguido de aspa e quebra de linha esconde um `INTO OUTFILE`, e o texto é classificado como leitura. A falha já existia no baseline e continua. | execução | Scanner por dialeto |
| P0-3 | DB-05 | `packages/db-drivers/src/mssql.ts:47-57` | O modo stream do SQL Server só registra listeners de `recordset` e `row`. A biblioteca `mssql` 12.6.0 emite `'error'` nesse modo, e emitir `'error'` sem listener lança exceção: a chamada derruba o processo ou fica pendurada, e o batch pode registrar `committed`. A engine nunca foi executada. | código | Listener que rejeita a promessa; teste com emissor falso e com servidor real |
| P0-4 | EXE-07 | `packages/code-agent/src/tools/exec-command.ts:886-894`; `apps/http-api/workers/coder-worker.ts:1222`; `apps/http-api/workers/company-worker.ts:665` | `disposeExecCommandSessions` deixou de ser síncrono e agora aguarda o `exitedPromise` de cada sessão, sem prazo. A sessão só fecha no evento `close`. Basta um descendente segurar o stdio, ou o circuit breaker de `process-tree.ts` pular o kill, para o `stop` do worker travar antes de `disposeTrackedProcessTrees()` (coder) e de `abortAll` (company). | código | Prazo no dispose; estados `exit_observed`, `draining` e `cleanup_incomplete`; matar a árvore enquanto o PID está fixado |

### 4.1 Correções aplicadas em 26/10/2026

As correções foram feitas depois da auditoria, a pedido do usuário, sem tocar nos outros achados. Para cada P0, o teste de regressão foi executado antes da correção e falhou; depois da correção, passou. As mudanças estão no working tree e não foram commitadas.

| # | Correção | Teste de regressão | Antes da correção |
|---|---|---|---|
| P0-1 | O dollar-quote do PostgreSQL virou uma dimensão opcional do lexer (`ScanMode.dollarQuotes`, `packages/db-drivers/src/sql/read-guard.ts:11-28,52`). `isReadStatement` e `hasMultipleStatements` exigem acordo entre as 16 combinações de escape por barra, `--` do MySQL, dollar-quote e `#` (`read-guard.ts:91-96`). | `packages/db-drivers/src/__tests__/read-guard.test.ts` › "does not let a dollar-quoted region hide a statement from dialects without dollar quoting" | `a$$; DELETE…; b$$` e `$$; DELETE…; $$` passavam como leitura de um statement |
| P0-2 | O `#` como comentário de linha virou outra dimensão (`ScanMode.hashComments`, `read-guard.ts:65-69`). | `read-guard.test.ts` › "treats a MySQL # line comment as a comment when admitting reads" | O texto com `#` e `INTO OUTFILE` passava como leitura |
| P0-3 | `boundedMssqlQuery` registra um listener de `'error'`, guarda o primeiro erro e o relança depois de `query()` (`packages/db-drivers/src/mssql.ts:47-64`). O batch então faz rollback e registra falha. A função foi exportada para o teste. | `packages/db-drivers/src/__tests__/mssql-stream.test.ts` (novo) › "rejects with the error the driver reports as an event", com um emissor que imita o modo stream da `mssql` 12.6.0 | Exceção não tratada e consulta pendurada até o timeout |
| P0-4 | `disposeExecCommandSessions` espera o fechamento das sessões por no máximo 10 s e depois as remove do registro (`packages/code-agent/src/tools/exec-command.ts:889-905`). O timer fica referenciado, para a espera terminar num host isolado, e é limpo assim que as sessões fecham. | `packages/code-agent/src/tools/__tests__/exec-command.test.ts` › "disposeExecCommandSessions" › "finishes even when a session transport never closes" | O descarte continuava pendente depois de 60 s de relógio simulado |

**Verificação depois das correções**

- `pnpm typecheck` (backend e dashboard): 0 erros.
- 14 arquivos de teste relacionados, em Node comum: 185 testes passam. São `read-guard`, `mssql-stream`, `mssql-module`, `mssql-dialect`, `batch-outcome`, `dump`, `identifiers`, `preview`, `templates`, `mutation-fence`, `permission-gate-riskof`, `tier-contract`, `grid-export` e `description-style`. A integração com SQL Server e Oracle continua ignorada sem servidor.
- `exec-command.test.ts` inteiro, com processos reais: 16 testes passam.
- `pnpm check:loc` acusa só a violação anterior do `service.ts`, e `git diff --check` passa.
- Não executados: os testes que abrem SQLite real (handlers do db-client, tools de DB do agente e a parte da suíte de `db-drivers` que usa SQLite). O addon nativo está compilado para o Electron, e o Node comum não o carrega. Comando para rodá-los:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run packages/api-handlers/src/db-client/__tests__ packages/code-agent/src/tools/db/__tests__/tools.integration.test.ts packages/db-drivers/src/__tests__
```

**Trocas e limites**

- Um dollar-quote do PostgreSQL que contenha `;`, aspas ou marcador de comentário volta a ser recusado como leitura, como no baseline. Sem dialeto negociado, o classificador não pode aceitar esse trecho. O caso antigo de `read-guard.test.ts` que afirmava o contrário foi trocado por `SELECT $$hello world$$`, que é seguro em qualquer dialeto.
- O fallback para `exec` do SQLite (`sqlite.ts:66-67`) continua. Com o classificador corrigido, o agente recusa esses textos antes do envio.
- O DB-01 continua parcial: o scanner modela os recursos de cada dialeto de forma conservadora, mas não recebe o engine, e não há corpus adversarial por engine.
- A correção do SQL Server foi provada com emissor simulado; a engine real continua sem execução.
- O descarte com prazo não registra `cleanup_incomplete` nem garante o término da árvore quando o kill é pulado (P1 29). Uma sessão que estoura o prazo sai do registro como no baseline, e o processo pode seguir vivo.

## 5. Achados P1

### Indexação e busca

| # | Req. | Local | Achado | Verificação | Ação proposta |
|---|---|---|---|---|---|
| 1 | IDX-04, IDX-11 | `apps/dashboard/features/project/bottom/FindResults.tsx:51`; `FileTreeView.tsx:166,265`; `SearchEverywhere.tsx:164-209` | Cobertura parcial e chamada que falhou aparecem como ausência ("No matches.", "No files match"). Uma falha semântica aparece como um fallback FTS que não existe. | código | Estados distintos para falha, parcial e vazio completo, consumindo `coverage` |
| 2 | IDX-01, IDX-02 | `packages/indexer/src/indexer/structural.ts:325` | Qualquer erro de arquivo descarta a publicação inteira. O caminho que falha volta em todo lote e trava a convergência do projeto. | código | Retry por caminho; `permanent_error` registrado na cobertura; publicar os sucessos |
| 3 | IDX-01, IDX-02 | `packages/services/src/services/project-index/dirty-queue.ts:38` | O journal grava de forma síncrona na conexão central do processo principal, antes da fila em memória. Um `SQLITE_BUSY` rejeita o evento inteiro. | código | Persistir fora do main sem perder a pendência em memória; medir o lag |
| 4 | IDX-03, IDX-06 | `packages/indexer/src/indexer/structural-generation.ts:23` | O staging do reconcile integral tem teto de 2 GiB e publica tudo numa única transação. Só foi testado com 2 arquivos. | frente | Medir em 50 mil e 150 mil arquivos; particionar |
| 5 | IDX-08 | `packages/indexer/src/indexer/live-paths.ts:28` | A varredura de disco usa `dot: true`, enquanto o índice e o baseline usam `dot: false`. Com isso `grep_code` lê dotfiles não ignorados, como um `.env` fora do `.gitignore`, e entrega trechos ao agente. | código | Mesma elegibilidade do scanner; teste com dotfile |
| 6 | IDX-12 | `scripts/verify-agent-reliability-upgrade.ts:16-21` | O teste de upgrade cobre só o DB central em runtime de fonte. Rodou às 19:15Z, antes das mudanças no caminho de migração (20:49Z e 21:05Z) e do pacote final (22:21Z). Nunca migrou DBs por projeto, que o desktop usa por padrão. | código e horários | Repetir 270→273 com DBs por projeto no executável final |
| 7 | IDX-07 | `apps/dashboard/features/project/bottom/useFindReplace.ts:34` | O grep do IDE não cancela nem descarta respostas superadas. | frente | AbortController e guarda de sequência |
| 8 | IDX-05, MCP-09 | `apps/mcp-server/tools/live-grep.ts:31-73` | O cenário-alvo do agente não tem regressão em `grep_code`: hit em arquivo indexado com arquivo novo, e zero hits com cobertura parcial. | frente | Dois testes |
| 9 | IDX-10 | `packages/indexer/src/search/lexical-concepts.ts` | O léxico PT→EN foi criado às 20:31Z, depois da ablação (18:56Z), e espelha o fixture. O holdout foi escrito às 21:09Z, reaproveita os 40 alvos do fixture, e 39 das 40 consultas PT contêm palavras do léxico. O ganho em PT não está demonstrado fora do ajuste. | execução e horários | Registrar o léxico como tuning; avaliar em corpus não usado no ajuste |

### Descoberta e MCP

| # | Req. | Local | Achado | Verificação | Ação proposta |
|---|---|---|---|---|---|
| 10 | MCP-01, MCP-10 | `packages/code-agent/src/tools/mcp-catalog-listing.ts:53`; SDK 1.29.0 `client/index.js:539-568` | Cada `listTools` limpa e recarrega o cache de validadores do SDK só com a página atual. Depois de paginar, só a última página fica com validação de `outputSchema` e de `taskSupport`; antes, quem tinha era a página 1. | código (SDK) | Popular o cache com o catálogo acumulado ou validar localmente; fixture multipágina com `outputSchema` |
| 11 | MCP-03 | `apps/http-api/sse/mcp-external-pool-runtime.ts:100-104,298-304` | O refresh por fonte não chega ao produto. O pool faz rebuild total (`closeAll`), e `McpServerManager.refreshAll` só é chamado em teste. Mudar a fonte B fecha a fonte A. | código | Reconciliar por fonte dentro do pool |
| 12 | DSC-07 | `packages/code-agent/src/core/runner/nodes/executing.ts:906-909` | Violação de limite verificado lança um erro genérico dentro do `try` do provider e entra no retry de erro transitório. Só `maxNameChars` é declarado, então uma tool opcional com nome acima de 64 caracteres aborta o turno. | código | Erro tipado não-retryable; limites como entrada da seleção |
| 13 | DSC-07 | `packages/code-agent/src/tools/implement-subagent.ts:125-150` | `wrapProviderForSubagentFence` não repassa `toolLimits`, e os subagentes perdem os limites. | código | Repassar e testar |
| 14 | DSC-06 | `packages/code-agent/src/core/tool-projection.ts`; `capability-catalog-tool.ts:295-301` | O receipt não segue `ActivationReceiptV2`. Faltam as revisões, `projectionState` e os motivos tipados, e ele confunde visibilidade com autoridade. Além disso, não chega ao turno seguinte, e o `activate` do catálogo continua com `projectionDigest:null`. | frente | Implementar o contrato; teste de integração do ExecutingNode |
| 15 | DSC-08 | `packages/code-agent/src/tools/code-exec.ts:1176-1182`; `find-tools.ts:189,265` | `list_tools()` continua despejando o catálogo inteiro, e `find_tools` recomenda usá-lo. | frente | Paginar |
| 16 | MCP-08, MCP-01 | `mcp-catalog-listing.ts:117-118`; `mcp-server-manager.ts:271-274` | Os bytes são medidos só depois do parse, e `callTool` não tem limite até a guarda de 8 milhões de caracteres. Qualquer estouro descarta a fonte inteira, sem catálogo parcial. | frente | Limite no transporte; catálogo parcial com completude |
| 17 | MCP-06 | `packages/code-agent/src/tools/mcp-server-manager.ts:271-272` | Prazo expirado antes do envio lança um erro comum dentro do despacho e vira "unknown" sem que nada tenha sido enviado. A conexão ainda é marcada como desconectada. | código | Checar o saldo antes do despacho ou lançar rejeição tipada |
| 18 | MCP-02 | `mcp-server-manager.ts:131-193,430-441` | Uma fonte lenta segura a publicação das outras, e `listToolsFromConnection` roda sem signal. | frente | Publicar por fonte |
| 19 | DSC-01, 03, 05, 09; MCP-10 | — | Critérios P1 sem teste: equivalência entre adapters, exato primeiro, abstenção em empate, invalidação de cache e fixtures de versão. O corpus não tem as classes ambígua, indisponível, bloqueada e schema grande (07 §5). | frente | Testes e corpus do 07 §5 |

### Execução

| # | Req. | Local | Achado | Verificação | Ação proposta |
|---|---|---|---|---|---|
| 20 | EXE-01 | `core/runner/nodes/executing-dispatch.ts:877-880`; `tools/code-exec.ts:923-924,1054` | A política de outcome diverge. No nested, timeout após o despacho vira unknown para qualquer efeito; no direto, só para MCP externo. | frente | Política única e teste diferencial |
| 21 | EXE-03 | `packages/code-agent/src/tools/code-exec.ts:1511` | O cancelamento não alcança o avaliador, que segue até o budget ou o watchdog (10 a 30 s), acima da meta de 2 s. | frente | Fechar o avaliador no abort |
| 22 | EXE-03 | `tools/code-exec-evaluator.ts:114-135`; `tools/code-exec-supervisor.ts:17` | O avaliador fica órfão se o host morrer durante um spin. | frente | Prazo próprio e término quando o pai morre |
| 23 | EXE-03 | `packages/code-agent/src/tools/code-exec.ts:1453` | O avaliador em processo virou padrão sem medição de startup ou RSS e sem chave de rollback, que é o gate "custo medido" do B10. | código | Medir; chave de interpretador para novas execuções |
| 24 | EXE-07, EXE-09 | `tools/exec-command.ts:613,422`; `tools/process-output.ts:35,58` | As cotas são globais: 16 sessões e 64 spools somando todos os owners. O 65º exec em 10 minutos falha, e não há `RESOURCE_EXHAUSTED`. | frente | Cota por owner; erro tipado com as sessões do caller |
| 25 | EXE-09, CTR-06 | `packages/code-agent/src/tools/process-output.ts:47-83` | A retenção da saída depende de um timer em processo. Depois de quit ou crash, a saída fica em claro sem prazo, e os testes gravam no diretório real do usuário. | frente | Varredura no startup e no shutdown; isolar os testes |
| 26 | EXE-06 | `tools/shell-command-safety.ts:57`; `tools/command-spec.ts:31` | Em POSIX, o modo argv contorna a guarda de kill amplo (`pkill`, `killall`). | frente | Classificar sobre executável e argumentos estruturados |
| 27 | EXE-06 | `tools/command-spec.ts:26`; `tools/exec-command.ts:414-420` | No shell `cmd`, as aspas internas chegam como `\"`, porque os argumentos não são passados verbatim. | frente | Linha verbatim para cmd; corpus Windows |
| 28 | EXE-08 | `packages/code-agent/src/tools/exec-command.ts:792-799` | `write_stdin` vazio continua classificado como execução. | frente | `riskOf` derivado de `chars` |
| 29 | EXE-07 | `tools/exec-command.ts:452-461`; `packages/shared/src/utils/process-tree.ts:197-222` | O cleanup não tem término gracioso, verificação nem registro do resultado. | frente | TERM, prazo, KILL, verificação da árvore e evidência |
| 30 | EXE-02, EXE-04 | `packages/code-agent/src/tools/code-exec.ts:94-140,604-656` | `invoke` estruturado e os budgets não têm teste nem documentação, e o F15 continua aberto. | frente | Testes de objeto e string, ciclo, >16 MiB e 129 RPC |
| 31 | EXE-06..10 | `packages/code-agent/src/tools/__tests__/exec-command.test.ts` | Nenhum teste cobre os caminhos novos: CommandSpec, owner, 17ª sessão, poll/stop, TTL, cauda após exit e árvore com neto. | frente | Fixtures que registram PID, com cleanup |
| 32 | EXE-11 | `packages/code-agent/src/tools/exec-command.ts:418` | Não há ledger de PID nem reconciliação após crash. | frente | Ledger durável com reconciliação no startup |

### Database

| # | Req. | Local | Achado | Verificação | Ação proposta |
|---|---|---|---|---|---|
| 33 | DB-04 | `packages/db-drivers/src/mysql.ts:211-216` | O batch do MySQL devolve ao pool uma conexão abortada, e o `KILL QUERY` tardio pode atingir o próximo usuário dela. | frente | Destruir a conexão abortada |
| 34 | DB-04 | `postgres.ts:143,194`; `mysql.ts:111,167` | Cancelamento e prazo não atravessam a fila de aquisição de conexão. | frente | Corrida entre signal e aquisição; medir uma operação enfileirada |
| 35 | DB-07, DB-11 | `packages/code-agent/src/tools/db/tools.ts:117-122` | `db_schema` com `table` e sem `schema` chama `describeTable('', tabela)`, e PG e MySQL devolvem colunas vazias sem erro. O baseline falhava explicitamente. | código | Resolver o schema padrão ou devolver erro explícito |
| 36 | DB-09 | `apps/dashboard/features/db-client/data/DataGridTab.tsx:216-217` | **Regressão**: a edição é desligada sem aviso em qualquer página com célula objeto. Datas, JSON e buffers chegam como objetos pelo IPC, então tabelas com timestamp, json ou bytea deixam de ser editáveis. | código | Serialização canônica por tipo; mensagem visível |
| 37 | DB-10 | `packages/api-handlers/src/db-client/export.ts:21`; `packages/db-drivers/src/sql/export-page.ts:10-13` | O keyset usa o valor JS da PK. Uma PK temporal em microssegundos vira Date em milissegundos e duplica linhas entre páginas. | frente | Checkpoint em representação nativa; fixture com PK temporal |
| 38 | DB-06 | `packages/code-agent/src/tools/db/pool.ts:27-29,48` | Não existe revisão monotônica persistida. `specCache` e `lastSeenVersion` nunca são limpos, e a rotação do manager não tem chamador. | frente | Coluna de revisão; limpeza no retire |
| 39 | DB-03 | `postgres.ts:104`; `oracle.ts:345`; `result-window.ts` | Bytes e célula só são limitados depois de materializar a linha, e MySQL e MSSQL recebem o resultado inteiro. | frente | Lotes guiados por bytes; parada antecipada |
| 40 | DB-08 | `packages/db-drivers/src/types.ts:213-263`; `QueryConsole.tsx:299-309` | Não há contrato de capabilities, e a UI oferece "Atomic" para MySQL e Oracle. | frente | Capabilities por engine e operação |
| 41 | DB-02 | `packages/api-handlers/src/db-client/index.ts:56-58,269-279` | O host aceita a chave e o spec vindos do renderer, sem revisão. Não há teste de IDs iguais em dois projetos (gate B09). | frente | Resolver a identidade no host; teste cruzado |
| 42 | DB-11 | `DataGridTab.tsx:89,92,148`; `mssql.ts:178,222` | O grid não tem prazo, queryId nem cancelamento, e o SQL Server recusa schemas diferentes de `dbo`. | frente | Herdar o prazo da aba; testes de schema homônimo |
| 43 | DB-05 | `packages/db-drivers/src/__tests__/batch-outcome.test.ts` | A prova de outcome é só unitária: não há falha injetada antes, durante ou depois do COMMIT, nem DDL com commit implícito. | frente | Injeção de falha por fase |

### Contratos, benchmarks e release

| # | Req. | Local | Achado | Verificação | Ação proposta |
|---|---|---|---|---|---|
| 44 | CTR-06 | `packages/code-agent/src/index.ts:3604-3611` | A telemetria de turno persiste `args` e `result_text` integrais (SQL, comandos, paths e resultados). A allowlist nova vive num array em memória, sem sink. | código | Allowlist e redação no caminho persistido |
| 45 | CTR-05, CTR-01 | `packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:666-667,876-899` | Timeout, abort e recusa do runner saem sem evidence. O reuso do lote copia o `invocationId` de outra chamada, e o finalizador e o postProcess não atualizam o estado. | frente | Sintetizar a evidence no dispatcher |
| 46 | CTR-04 | `executing-dispatch.ts:742-744` | O prazo absoluto só existe com `toolTimeoutMs>0` e no nested. O bridge interno, exec/shell, http, grep e IDE/API não o recebem. | frente | Propagar a todos os donos físicos |
| 47 | CTR-02 | `packages/code-agent/src/index.ts:3890-3896` | As revisões de catálogo e de autorização são só gravadas; nenhum cache ou selo as consulta. | frente | Usar em chave ou selo, com teste de invalidação |
| 48 | G3 | `evals/agent-effectiveness/disconnected-config.mjs` | O verificador V2 foi gravado às 22:40:02Z, depois das falhas das execuções 1 (22:25Z) e 4 (22:37Z) do explore. Ele aceita frases erradas, como "SESSION_TTL_MS não é usado diretamente pelo token". Pelo 07 §6, o critério não muda depois de observar a falha, então o resultado primário desta rodada é o do V1: 20/25 e −9,5% de tokens por tarefa correta. | execução e horários | Publicar o V1 como primário; pré-registrar o V2 para a próxima rodada, com negativos de sujeito errado |

## 6. Achados P2

**Indexação e busca**

- O abort no rerank global vira sucesso, e o pipeline engole o abort (`packages/indexer/src/search/hybrid.ts:347-374`).
- A `completeness` de paths é heurística: fica sempre parcial acima de 5.000 arquivos. A revisão é lida fora do snapshot (`packages/api-handlers/src/files/index.ts:120-126`).
- Com mais de 5.000 arquivos indexados, `discoveredFiles` conta arquivos que não são novos. Um arquivo acima de 1 MiB torna `complete=false` sem motivo declarado.
- A regex do usuário roda de forma síncrona no processo MCP para gerar os path hints (`apps/mcp-server/tools/live-grep.ts:58`).
- O grep do IDE não tem teto de arquivos nem de bytes, e o estouro de prazo vira exceção sem evidência parcial (`packages/api-handlers/src/search/text-grep.ts:99-102`).
- Os triggers de revisão congelam a lista de colunas no momento da migração (`271-structural-state.ts:19-20`). Isso dá cerca de três incrementos de revisão por arquivo.
- A política de modo diverge entre a API (`hybrid`) e o MCP (`auto`), e o F06 continua aberto.
- `DirtyQueue.clear` e `journal.clear` não têm chamador, e `structural_dirty` não é limpo quando o projeto é removido.
- Testes:
  - o nome de um teste contradiz a asserção (`project-index-service.test.ts:713`);
  - `hybrid-cache-revision` não verifica o cache;
  - não há `EXPLAIN QUERY PLAN`;
  - os logs trazem só contagens.
- `project-index/service.ts` com 515 linhas quebra o `pnpm check:loc`.

**Descoberta e MCP**

- Os aliases são globais, não por capacidade, e não há IDF. A chave `esquema_sql` nunca casa. As consultas PT do corpus derivam da mesma tabela de aliases.
- Com overlay, `structuredData` duplica o texto e entrega dado anterior ao overlay (`mcp-bridge.ts:348-350`).
- A disponibilidade é sempre `attempt_snapshot`, e o receipt e o `activate` usam digests diferentes.
- `structuredData` não tem limite em `find_tools` e `expand_toolset`. Com registry não selado, os descritores são derivados de novo a cada chamada.
- O health check de 60 s relista todas as páginas. Uma fonte acima do orçamento entra em ciclo de erro, reconexão e nova listagem.
- No mapa de contexto, qualquer arquivo sem símbolo disputa o orçamento, não só JSON e YAML. O teste usa orçamento de 4.000 caracteres, não o real.
- Código morto: `passesRelaxed`/`passesStrict`, `coverage` em find-tools, tipos em mcp-server-manager e `normalizeSourceTruncations`. `prompt-budget.test.ts` eleva os budgets de outras seções (visão e Ultra).

**Execução**

- `recoverable:true` aparece sem `outputId`, enquanto a evidence declara `recovery:'none'`. O resultado não traz owner, signal, tempos nem shell efetivo. stdout e stderr saem mesclados, e o PTY marca exit sem flush.
- `close()` do supervisor mata a raiz antes da árvore (`code-exec-supervisor.ts:95-98`).
- No RPC do avaliador:
  - a varredura dos frames é quadrática;
  - `structuredData` cíclico derruba o batch;
  - `log` de um objeto cíclico aborta o script.
- A descrição do code_exec omite os limites (16 MiB, 128 RPC, heap) e o `invoke`.
- O executável argv não é normalizado no fence.
- Código morto: `enforceMaxOpen`, o sandbox do host (`code-exec.ts:1146-1302`) e `CODE_EXEC_MAX_REQUESTS`.
- `execTesting.disposeAll()` não é aguardado em `mutation-fence.test.ts:725`. `read_process_output` herda `repeatPolicy:'stable'`.
- A evidence v2 marca `unknown` em recusas de admissão e `confirmed` num `stop_session` que ainda está em `stopping`.
- O avaliador e o worker do grep são strings `String.raw`, fora do typecheck e do lint.

**Database**

- `retire` espera a drenagem sem prazo, então connect, disconnect e shutdown podem ficar presos.
- Export e dump agora recusam tabelas sem PK e views. A quota de 1.024 recibos não tem retenção, o import tem prazo fixo de 60 s, e LOB do Oracle é recusado.
- `schemaSnapshot` continua integral. `searchCatalog` devolve só a primeira página, sem marcá-la como parcial.
- O comando raw do Redis materializa a resposta inteira, e a limitação não é declarada ao agente.
- MSSQL, Oracle, Mongo e Redis só medem `totalMs`, e a UI não mostra os estágios.
- Há duas implementações de cursor assinado, e a assinatura não é comparada em tempo constante.
- Os logs de PG e MariaDB rodaram testes inalterados, antes das últimas edições dos drivers.
- Não confirmado: o falso positivo com barra invertida alegado pela frente não se reproduziu na execução.

**Contratos e release**

- `packaged-runtime-final` e os canários `1792963429535` e `1792963690125` são de um build anterior ao final, e os relatórios não gravam o SHA do executável.
- `sourceStable` não cobre `scripts/` nem `evals/`. O harness da rodada final não foi preservado.
- `structuredData` (até 1 MiB) e a evidence trafegam em todo `tool_call_result`, sem consumidor.
- O harness copia a chave Z.ai real do `index.db` do usuário para os perfis. A limpeza zerou as cópias, mas essa credencial não deveria ser fixture.
- `evals/agent-effectiveness/README.md` não foi atualizado.
- `QueryConsole.tsx:376` mostra as linhas observadas (limite + 1) como contagem.

## 7. Divergências entre o relatório original e a evidência

As linhas citam [IMPLEMENTATION-LOG.md](./IMPLEMENTATION-LOG.md), deslocadas em seis linhas pelo cabeçalho de proveniência.

**Tabela "Implementação por frente" (linhas originais 11–34)**

- A tabela apresenta prova para os 65 requisitos. Nenhum está entregue nos quatro eixos, e 4 estão pendentes.
- Indexação:
  - O `project-index-service` citado em IDX-01/02 não exercita o journal nem injeta falha.
  - Os "59 testes" de cancelamento não são rastreáveis por teste, e nenhum cobre busca global, FTS ou grep do IDE.
  - A ablação citada em IDX-10/11 é anterior ao léxico.
  - "Falha distinta de vazio" não foi implementada.
- Descoberta e MCP:
  - O corpus de descoberta mede só ranking.
  - Não foram criados testes de assembly.
  - O refresh por fonte está fora do produto.
  - MCP-10 não tem fixtures.
- Execução: as provas "contratos direta/nested, fan-out e resultado cíclico" e "Node process fixtures" não existem.
- Database:
  - O scanner não é por dialeto.
  - A "revisão" de conexão não existe.
- Contratos: a "whitelist de telemetria" não tem sink, e a telemetria persistida grava argumentos e resultados.

**Narrativa (linhas originais 36–191)**

- Linha 17 e linha 48: o upgrade rodou só no DB central, em runtime de fonte e antes do código final. "Candidato empacotado" não procede.
- Linha 27 e linhas 97–101: a evidência vem de um build anterior, mas é descrita como "mesmo executável final".
- Linha 42: o artefato citado é `quality/metrics.json`, mas o arquivo real é `quality/metrics.jsonl`.
- Linha 45: a primeira medição de latência (`ide-latency-final.txt`) falhou por timeout e não é citada.
- Linha 58: o relatório cita boundaries e diff-check, mas omite que `check:loc` falha.
- Linhas 60–61 e 147: o V2 foi escrito durante a rodada, então "critérios preservados" não procede.
- Linha 71: "Scripts versionados" não procede, porque todos os scripts estão untracked.
- Linha 91: o holdout "independente" foi escrito depois do léxico e reaproveita os alvos do fixture. O script do holdout foi alterado às 21:14Z, depois da execução registrada às 21:09Z.
- Linha 135: o "pacote Windows" é o diretório `win-unpacked` (`--win dir`); não há instalador.
- Linha 145: "sem build/testes concorrentes" não procede, porque os testes do V2 e as reavaliações rodaram durante a rodada.
- As mudanças fora da spec (§8) não são mencionadas.

## 8. Alterações fora do escopo da spec

### 8.1 Correções de gates quebrados no baseline

Os arquivos abaixo parecem alheios à spec, mas corrigem falhas que já existiam no commit `448d526d`, feito às 09:55 de 25/10. Foram alterados entre 15:09 e 15:58 durante a rodada. Evidências:

- `.tmp/agent-ide-reliability/boundaries.txt` (14:42) acusa seis violações novas, todas nesses arquivos;
- `workspace-tests.txt` (15:26) falha em `i18n-coverage.test.ts` e em `chat-right-rail-preview.test.ts`;
- o código do HEAD contém as importações proibidas, as strings fixas, o teste esperando 5 botões e as dependências não declaradas.

| Arquivo | Corrige |
|---|---|
| `apps/dashboard/features/chat/SessionWorkspaceBar.tsx`, `composer/Composer.tsx`, `i18n/locales/{en,pt-BR}/chat.json` | Strings visíveis fixas que reprovam o teste de cobertura i18n |
| `apps/dashboard/features/chat/right-panel/__tests__/chat-right-rail-preview.test.ts` | Teste que esperava 5 botões; o `ChatRightRail.tsx` inalterado renderiza 6 |
| `packages/agent-runtime-contracts/src/chat-network.ts` (novo, 25/10 00:22), `packages/api-bus/src/index.ts`, `packages/session-storage/src/collaboration/network-types.ts`, `apps/dashboard/features/chat/right-panel/{SessionNetworkSetup.tsx,network-types.ts}` | Importação proibida desktop → core (`forbidden-domain-import`) |
| `scripts/sessions-fs-migrate/__tests__/app-studio-migration-electron.test.ts` | Import relativo entre unidades |
| `packages/provider-runtime/package.json`, `packages/code-agent/package.json` | Dependências já usadas e não declaradas (`vitest`, `@mcp/services`, `@mcp/api-bus`) |

Nenhum arquivo mantido importa os tipos movidos, então o grupo é autocontido. Ele deve entrar num commit separado, antes dos demais. Descartá-lo derruba os gates citados no relatório.

### 8.2 Colaterais

- `packages/session-storage/src/session-writer.ts` e o teste correspondente tratam como "sem lease" um isolate que saiu antes de criar o diretório de eventos. A mudança é justificada pela falha da suíte ampla.
- `chat-changes.ts`, `chat-collaboration.ts` e `session-network.ts` passam a devolver `okStructured`, ligado ao ADR-05. O texto visível ao modelo muda de JSON para Markdown com `structuredData`.
- `scripts/build-electron.mjs` pula o `electron-rebuild` quando a sonda de ABI passa. A sonda testa só `SELECT 1`.
- `scripts/release/smoke.cjs` ficou mais estrito e falha por erro de runtime.
- `packages/api-handlers/package.json` ganhou `@mcp/indexer` e `@mcp/services` (busca). O `pnpm-lock.yaml` mistura entradas de várias frentes.

## 9. Proposta de commits (não executada)

Ordem sugerida. Os grupos têm dependências cruzadas (por exemplo, `invocation-evidence` é usada por várias frentes), e nenhum commit foi compilado isoladamente.

| # | Conteúdo | Arquivos |
|---|---|---|
| 1 | Dependências: `package.json` da raiz e de sete pacotes, `pnpm-lock.yaml` | 9 |
| 2 | Correção dos gates do baseline (§8.1, sem os `package.json`) | 11 |
| 3 | Spec, auditoria e estado (`docs/specs/agent-ide-reliability/`) | 11 |
| 4 | Contratos CTR, resultados estruturados e `toolLimits` do provider | 20 |
| 5 | Indexação e busca, incluindo as migrações 271–273 | 77 |
| 6 | Descoberta e MCP, incluindo o mapa de contexto | 34 |
| 7 | Execução: code_exec, comandos, process-tree e workers | 25 |
| 8 | Database: drivers, handlers, UI db-client e i18n `dbClient` | 66 |
| 9 | Scripts, evals e benchmarks | 30 |
| 10 | Colaterais: session-writer, build-electron e smoke de release | 4 |

As correções dos P0 estão nos grupos 7 e 8, e o teste novo `mssql-stream.test.ts` entra no grupo 8. Commitar o trabalho em andamento não promove nada. O ponto de decisão é promover ou instalar.

## 10. O que esta auditoria não cobre

- Reexecução da suíte ampla, do build e dos canários.
- Qualquer conexão a banco ou servidor MCP real.
- Execução das correções dos P0-3 e P0-4 contra um SQL Server real e contra uma árvore de processos real que segure o stdio. Os testes de regressão usam emissor e sessão simulados.
- Revisão de qualidade de código além dos critérios de aceite.
- Validação de UX visual além das capturas existentes.
- Avaliação de segurança completa: os achados de escopo de dotfiles, classificação SQL e telemetria apareceram como parte dos requisitos, não de um pentest.
