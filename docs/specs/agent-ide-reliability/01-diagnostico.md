# 01 — Diagnóstico do baseline

## 1. Método e grau de certeza

Auditoria em `D:\MCP`, commit `448d526dd2e24247617938721c0d8cf18ce850cf`, versão 3.15.1, em 25/10/2026. O checkout estava limpo antes da criação desta spec. A inspeção cobriu produtores, adapters, workers, consumidores da IDE/agente e testes existentes. Não foi feito benchmark do aplicativo instalado.

Classificações usadas:

- **R — reproduzido:** função real executada com entrada sintética, sem operação de banco ou serviço externo.
- **C — confirmado no código:** caminho/contrato observável na revisão; o impacto quantitativo ou a manifestação no produto ainda requer teste.
- **H — hipótese/risco condicional:** mecanismo plausível, mas depende de configuração, carga ou ciclo de vida ainda não reproduzido.
- **M — medição pendente:** não há números atuais suficientes para concluir sobre latência, consumo ou benefício.

Prioridade é de implementação: P0 protege correção/autoridade e elimina garantias falsas; P1 fecha utilidade e limites; P2 melhora eficiência/UX depois das bases. P0 não significa que houve corrupção ou exploração na instalação do usuário.

## 2. Mapa das superfícies

| Área | Produtor/owner | Exposição/consumo |
|---|---|---|
| Deltas e lifecycle do índice | `packages/services/src/services/project-index/`; `packages/indexer/src/indexer/` | `apps/http-api/sse/IndexerWorkerClient.ts` e rotas de projeto |
| Busca estrutural/semântica | `packages/indexer/src/search/`; `packages/store/src/db/files.ts` | API search, MCP `search`/`grep_code`, FileTreeView e SearchEverywhere |
| Descoberta e seleção | `packages/code-agent/src/tools/find-tools*.ts`, `expand.ts`, `capability-catalog-tool.ts` | Registry, runner assembly, projeção provider e `code_exec` |
| MCP interno/externo | `apps/mcp-server/`; bridges/managers em `packages/code-agent/src/tools/` | Pool externo, worker RPC e tools `mcp__*` |
| JS e comandos | `code-exec.ts`, `exec-command.ts`, `shell.ts`, ports e process-tree | Runner, processos/PTY, tool output e UI |
| Database | `packages/db-drivers/`; `packages/api-handlers/src/db-client/` | `packages/code-agent/src/tools/db/`; `apps/dashboard/features/db-client/` |

Não interpretar o prefixo `mcp_` como um subsistema único. Há busca de código interna, tools externas de outros servidores e adapters do agente; cada origem tem ciclo, política e formato próprios.

## 3. Achados prioritários

As referências abaixo são relativas à raiz do repositório. Detalhes e reproduções ficam nos documentos de domínio.

| ID | Nível / prioridade | Evidência | Consequência a corrigir |
|---|---|---|---|
| F01 | C / P0 | `packages/services/src/services/project-index/dirty-queue.ts:30`; `service.ts:412-470` no mesmo diretório | Lote removido antes do sucesso; erro RPC e erro por arquivo não mantêm retry garantido. |
| F02 | C / P0 | `packages/indexer/src/search/hybrid.ts:184,429-451`; `apps/http-api/server/routes/project-detail-routes.ts:155` | Cache com TTL de cinco minutos sem revisão estrutural pode continuar válido após commit de arquivo/símbolo. |
| F03 | C / P1 | `apps/mcp-server/tools/search.ts:275-341` | Grep só busca disco quando não houve hits; arquivo novo pode faltar quando outro indexado já encontrou o termo. |
| F04 | C + M / P1 | `packages/store/src/db/files.ts:6-22`; `apps/mcp-server/tools/search.ts:47-85,269-319`; `packages/services/src/services/code-reader.ts:113-149` | Resultado bounded, mas aquisição/enumeração/leitura não são bounded no mesmo grau. Custo real ainda não medido. |
| F05 | C / P1 | `packages/indexer/src/search/hybrid.ts:308-333,612`; `apps/http-api/sse/SemanticVectorWorkerClient.ts:238` | Sinal e contexto não atravessam todos os modos de busca global/vetorial. |
| F06 | C / P2 | `apps/dashboard/features/search-everywhere/SearchEverywhere.tsx:157-173`; `packages/api-handlers/src/search/index.ts:41` | Leituras independentes sequenciais e defaults distintos entre consumidores. |
| F07 | R / P1 | `packages/code-agent/src/tools/find-tools-score.ts:22,46,95` | Tokenização ASCII perde acentos; consulta PT simples não encontra fixture EN equivalente. |
| F08 | C + R / P1 | `packages/code-agent/src/tools/find-tools.ts:195-211` | Promoção do top strict sem margem de ambiguidade; termo genérico pode empatar leitura e escrita. |
| F09 | C / P0 | `packages/code-agent/src/tools/expand.ts:149-160`; `core/runner/assembly/tools.ts:264-289` e `providers/capabilities.ts:178-195` sob code-agent/src | Expansão pode prometer conjunto que a projeção cortará; protected set pode ultrapassar teto local configurável. Falta separar limite físico validado do provider de limites de sessão. |
| F10 | C / P1 | `packages/code-agent/src/tools/capability-catalog-tool.ts:252-294`; `code-exec.ts:1171` | Catálogo canônico já existe, mas receipt de ativação não confirma projeção e listagem nested é integral. |
| F11 | C / P0 | `packages/code-agent/src/tools/mcp-catalog-listing.ts:50,61` | Listagem ignora `nextCursor`; fontes paginadas ficam incompletas. SDK 1.29.0 local retorna uma página por chamada. |
| F12 | C + M / P1 | `packages/code-agent/src/tools/mcp-server-manager.ts:135`; `apps/http-api/sse/mcp-external-pool-runtime.ts:100,299,405` | Discovery serial e refresh amplo podem atrasar/perturbar fontes saudáveis; latência real pendente. |
| F13 | C / P0 | `packages/code-agent/src/tools/mcp-bridge.ts:311-353`; `mcp-server-manager.ts:311-325` | Bridge interno perde `structuredContent`, enquanto externo preserva; consumidores recebem contratos diferentes. |
| F14 | C / P1 | `apps/mcp-server/tools/search.ts:148-234`; `packages/code-agent/src/tools/mcp-output-guard.ts:8` | Busca projeta Markdown sem dado estruturado; há limites de output após materialização e caps de entrada inconsistentes. |
| F15 | C / P1 | `packages/code-agent/src/tools/code-exec.ts:1007-1043,636,1410` | Composição recebe string; resultados intermediários completos podem ser copiados em múltiplas estruturas. Medir impacto antes de alegar vazamento. |
| F16 | C + H / P0 spike | `packages/code-agent/src/tools/code-exec.ts:1446-1450` | Proteção síncrona de VM não prova interrupção de loop após await; validar com supervisor descartável, fora do app. |
| F17 | C + H / P0 | `packages/code-agent/src/tools/exec-command.ts:136-160,443-459,623,863` | Dispose local mata handle direto; TTL/eviction e shutdown têm garantias diferentes. Risco de filhos vivos exige teste de árvore. |
| F18 | C / P1 | `packages/code-agent/src/tools/exec-command.ts:325-348,546-578,585,479` | Logs descartados sem recuperação; output arg ausente do schema; finalização em exit requer teste de drain. |
| F19 | R / P0 | `packages/db-drivers/src/sql/read-guard.ts:12` | Strings contendo marcadores de comentário alteram classificação de instrução única e leitura. |
| F20 | C + M / P1 | `packages/db-drivers/src/postgres.ts:107,436`; `mysql.ts:109,379`; `mssql.ts:187,495` no mesmo diretório | PG/MySQL/MSSQL materializam antes de fatiar; maxRows não é limite físico de aquisição. |
| F21 | C / P1 | `packages/db-drivers/src/sqlite.ts:43-76`; `packages/api-handlers/src/db-client/index.ts:4` | Cliente SQLite executa trabalho síncrono no caminho do main. |
| F22 | C / P0 | `packages/api-handlers/src/db-client/index.ts:454-518`; `packages/db-drivers/src/types.ts:219` | Batch anuncia rollback universal incompatível com capacidades reais e commit incerto. |
| F23 | C / P1 | `apps/dashboard/features/db-client/data/DataGridTab.tsx:46,147`; handlers db-client `index.ts:473-506` | Grid/custom SQL e batch read-only não preservam schema/sessão de forma equivalente. |
| F24 | C + H / P1 | `packages/db-drivers/src/manager.ts:53`; `postgres.ts:154`; `mysql.ts:159`; tools db `pool.ts:48` | Lifecycle sem lease ativo, cancelamento sob saturação e revisão por timestamp precisam de fechamento. |
| F25 | H / P0 teste | `packages/api-handlers/src/db-client/index.ts:51`; `apps/http-api/server/project-feature-store.ts:18` | Identidade sem projeto pode colidir se IDs locais por projeto estiverem ativos; não reproduzido nesta instalação. |
| F26 | C / P1-P2 | `packages/code-agent/src/tools/db/tools.ts:112`; handlers db-client `index.ts:162,350,645`; `packages/db-drivers/src/sql/dml.ts:50` | Catálogo varre antes de paginar; edição não detecta concorrência; export não declara snapshot/ordem suficientes. |
| F27 | M / P0 baseline | `evals/agent-effectiveness/README.md`; `src/benchmarks/search-quality.ts`; testes E2E de busca | Há harness, mas esta análise não mediu sucesso atual, ganho semântico, custo total ou app instalado. |

Os arquivos de driver F20/F21/F24 são conferidos no capítulo [05](./05-database.md); o registro de linhas deve ser atualizado no início da implementação se o HEAD mudar.

## 4. Reproduções limitadas realizadas

### Ranking de tools

Importação do scorer real em Node/tsx, fixture mínima com `read_file` e `write_file`:

| Consulta | Resultado observado |
|---|---|
| `read file` | Scores 10 e 5; ambos strict pelo limiar atual |
| `ler arquivo` | Score zero para ambos |
| `buscar referência` | Tokens `buscar`, `refer`, `ncia` |
| `path` | Empate score 4, ambos strict |

Isso confirma uma limitação do algoritmo, não uma taxa global de erros do agente. Gold set com ferramentas reais e provider é necessário antes de calibrar confiança.

### Classificação SQL

Execução das funções puras `isReadStatement` e `hasMultipleStatements`, sem conexão:

```text
SELECT '--'; DELETE FROM audit_fixture
=> isReadStatement=true; hasMultipleStatements=false

SELECT '/*'; DELETE FROM audit_fixture; SELECT '*/'
=> isReadStatement=true; hasMultipleStatements=false
```

O problema é a ordem de remoção de comentários em relação ao reconhecimento de strings. Isso exige correção antes de confiar na classificação; não demonstra que todos os drivers executariam o payload, pois há barreiras adicionais.

## 5. Mecanismos que não devem ser perdidos

| Existente | Garantia a preservar |
|---|---|
| Worker estrutural, pipeline stat/hash e parser cache | Não colocar indexação pesada de volta no main nem reprocessar tudo a cada alteração. |
| Watcher/polling, barreira de abertura e reconciliação | Evitar janela de eventos perdidos e manter modo real visível. |
| FTS/híbrido/RRF/reranker, revisão semântica e fallback | Melhorar medindo; manter lexical útil quando modelo estiver frio/indisponível. |
| File tree virtual e Search Everywhere progressivo | Não regressar para listagem integral de DBFiles no renderer. |
| Registry selado, capability catalog e classificação local | Não permitir que discovery ou metadata externa ampliem autorização. |
| Fence no envio, unknown outcome e proibição de replay | Não trocar segurança de execução por throughput aparente. |
| Gate físico de concorrência code_exec | Timeout lógico não libera lane enquanto a operação física ainda pode atuar. |
| Truncamento honesto e output store | Não declarar recuperação de dados já descartados. |
| DML parametrizado, escopo DB, read-only e pools | Não reimplementar DB como shell strings ou consultas sem contexto. |
| Test harness separado Node/Electron | Não reconstruir SQLite ABI para cada grupo de teste nem confundir skips com homologação. |

## 6. O que a análise não permite concluir

Não é possível atribuir hoje uma porcentagem de lentidão à indexação, ao LLM, a rede MCP, ao SQLite, ao renderer ou aos drivers. Não foi demonstrado vazamento de memória, incidente de dados, colisão de projeto ativa ou falha de todos os parsers/engines. Também não há evidência de que trocar embedding, vector store, pool size ou linguagem do runtime seja a primeira correção adequada.

A implementação deve transformar os casos C/H em regressões reproduzíveis e os casos M em baseline. Os gates de [07](./07-implementacao-e-validacao.md) definem quando uma hipótese pode virar conclusão de desempenho e quando uma correção pode ser promovida.
