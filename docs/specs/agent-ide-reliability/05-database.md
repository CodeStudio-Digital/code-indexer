# 05 — Database: consultas úteis, limitadas e com resultado verificável

Status: especificação para implementação; nenhuma correção de runtime entregue neste documento.
Data: 2026-10-25. Baseline: `448d526dd2e24247617938721c0d8cf18ce850cf`, versão 3.15.1.
Escopo: ferramentas `db_*`, drivers, API/IPC, cliente visual e sua interação com SQLite interno.
Auditoria: leitura do código e uma reprodução de função pura; nenhum banco conectado ou alterado.

## 1. Objetivo e fronteiras

O agente e a IDE devem localizar a conexão correta, descobrir o schema necessário, executar uma operação com limites reais e compreender seu resultado sem adivinhar se houve commit.
Uma página pequena na interface não basta: aquisição, execução no servidor, materialização, serialização e renderização precisam respeitar limites próprios.
Preservar os recursos existentes e corrigir contratos antes de adicionar engines ou novos modos de edição.

Há dois domínios distintos:

- **Bancos do usuário:** conexões registradas, consultas, documentos/chaves, DML, DDL, exportação e importação. Nunca executar migração de infraestrutura da IDE nesses bancos.
- **SQLite interno:** índice, metadados de conexões e outros catálogos locais. Aplicar mudanças somente por migrações versionadas, com backup e rollback compatíveis com o roteamento por projeto.

Não fazem parte desta entrega: administrar servidores externos, ajustar índices reais de clientes automaticamente, migrar o SGBD do usuário ou declarar homologadas todas as versões de engines.

## 2. O que já existe e deve ser aproveitado

| Recurso existente | Evidência no baseline | Preservação requerida |
|---|---|---|
| Quatro ferramentas `db_list`, `db_schema`, `db_query`, `db_command` | `packages/code-agent/src/tools/db/tools.ts:164`, `:193`, `:241`, `:333` | Manter nomes/argumentos legados durante evolução |
| Escopo por projeto e nomes desambiguados em Company | `packages/code-agent/src/tools/db/scope.ts:63` | Nenhuma descoberta deve ampliar acesso |
| Catálogo progressivo de schema, default 40/máximo 100 itens | `packages/code-agent/src/tools/db/tools.ts:105` | Não voltar à introspecção de todas as colunas por padrão |
| Factory com read-only e drivers para oito nomes de engine | `packages/db-drivers/src/factory.ts:17` | Preservar proteção no último limite antes do driver |
| Pools compartilhados, deduplicação de abertura e expiração | `packages/db-drivers/src/manager.ts:46` | Evoluir ownership sem criar pools paralelos ocultos |
| DML parametrizado por chave, preview e batch | `packages/db-drivers/src/sql/dml.ts:27`; `packages/api-handlers/src/db-client/index.ts:560` | Preservar parâmetros e prevenção de UPDATE/DELETE sem chave |
| Grid virtual, paginação, ER, diff de schema, explain e histórico | `apps/dashboard/features/db-client/` | Validar jornadas reais além de builders |
| Resultado incerto de mutações do agente | `packages/code-agent/src/tools/db/tools.ts:309`, `:413` | Nunca transformar cancelamento em garantia de rollback |
| Checkpoint do índice fora do main e timing SQL opcional | `apps/http-api/workers/db-maintenance-worker.ts:1`; `packages/store/src/db/sql-timing.ts:1` | Reutilizar observabilidade e isolamento existentes |

## 3. Diagnóstico com nível de evidência

**DB-F01 — classificador SQL incorreto, reproduzido sem banco (P0).**
`packages/db-drivers/src/sql/read-guard.ts:12` remove comentários antes de reconhecer strings.
O módulo real, importado por `node --import tsx`, produziu:

```text
SQL: SELECT '--'; DELETE FROM audit_fixture
isReadStatement = true; hasMultipleStatements = false

SQL: SELECT '/*'; DELETE FROM audit_fixture; SELECT '*/'
isReadStatement = true; hasMultipleStatements = false
```

Nenhum SQL acima foi executado. O achado prova falha de classificação/single-statement, não exploração efetiva em todos os drivers.
Ele afeta `riskOf`, a guarda de `db_query`, o wrapper read-only e handlers da IDE; algumas engines possuem defesas adicionais.

**DB-F02 — limite de linhas aplicado após materialização (P1).**
PostgreSQL espera `client.query` em `postgres.ts:107` e fatia em `:436`; MySQL espera em `mysql.ts:109` e fatia em `:379`; MSSQL espera em `mssql.ts:187` e fatia em `:495`.
O retorno ao agente/grid é limitado, mas o volume intermediário de uma consulta arbitrária não é limitado por esse contrato.
Pico de memória e latência reais ainda precisam ser medidos; não generalizar o problema para Oracle, Mongo ou SQLite, que já têm caminhos de aquisição limitados.

**DB-F03 — SQLite do cliente é síncrono (P1).**
`sqlite.ts:43-76` executa prepare/iterate/run antes de resolver a Promise; o handler declara execução no Electron main em `packages/api-handlers/src/db-client/index.ts:4`.
O limite de linhas não limita o trabalho de um agregado, ordenação ou expressão antes da primeira linha; o timer JS não interrompe esse trecho síncrono.
O índice interno já tem workers para partes de seu ciclo; isso não significa que o cliente SQLite do usuário esteja isolado.

**DB-F04 — batch e mensagem de rollback não têm a mesma garantia (P0/P1).**
`packages/api-handlers/src/db-client/index.ts:454-518` retorna texto afirmando rollback em qualquer falha de batch.
O próprio contrato em `packages/db-drivers/src/types.ts:219` diferencia DDL com commit implícito; o handler de migration já retorna `atomic` em `index.ts:622`, mas queryBatch não.
MySQL documenta que várias instruções DDL provocam commit implícito: [manual MySQL 8.4](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html).
Uma mensagem universal de rollback é incorreta; falha de transporte/commit também não permite essa garantia.

**DB-F05 — escopo de schema diverge entre superfícies (P1).**
DataGrid inicializa `SELECT * FROM ${table}` sem quoting/schema em `DataGridTab.tsx:46` e chama `api.runQuery(cid, q)` sem schema em `:147`.
A API aceita schema em `apps/dashboard/features/db-client/api.ts:367`, e a console o envia.
Em queryBatch read-only, o handler injeta `SET LOCAL`/`USE`/`ALTER SESSION` e usa `runQuery` separados (`index.ts:473-506`); o wrapper read-only rejeita esses comandos e não há sessão fixada nesse fallback.
Teste obrigatório: tabelas homônimas em dois schemas e console read-only com múltiplos SELECTs.

**DB-F06 — cancelamento em batch não tem paridade com query individual (P1).**
`postgres.ts:154-178` e `mysql.ts:159-183` não verificam novamente o sinal antes de cada statement/commit e reciclam a conexão após rollback bem-sucedido.
O caminho individual já descarta conexão abortada (`postgres.ts:114`, `mysql.ts:116`), prevenindo cancelamento atrasado contra outro usuário do pool.
Além disso, cancelamento PG/MySQL usa o mesmo pool de tamanho 3 (`postgres.ts:45,98`; `mysql.ts:44,99`): sob saturação, o pedido de cancelamento pode esperar uma conexão livre. Esse último impacto precisa de teste de concorrência.

**DB-F07 — catálogo pagina saída, mas percorre catálogo inteiro (P1).**
`db_schema` chama `listTables` antes de buscar/fatiar e também antes de expandir uma tabela exata (`tools.ts:112-131`).
Na IDE, `buildCatalog` enumera schemas e três grupos por schema, com concorrência 4; `schemaSnapshot` descreve todas as tabelas com concorrência 6 (`index.ts:162-180,350-354`).
Há TTL e deduplicação: não propor implementá-los como se inexistissem. Falta escopo, paginação na origem, cancelamento e orçamento total.

**DB-F08 — lifecycle usa recência, sem lease de operação (P1).**
O sweeper considera `lastUsed` e `pinned` (`manager.ts:53-59`); aquisição/get atualizam recência, mas não existe contador de operações em curso.
Uma operação longa em pool não pinned pode atingir o TTL de cinco minutos. Confirmar comportamento do close de cada driver com teste controlado.
Rotação do agente usa `updated_at` com precisão de segundo mais read-only (`pool.ts:48`); duas edições de credenciais no mesmo segundo podem manter a mesma versão. `db-client-store.ts:216` usa `datetime('now')`.

**DB-F09 — identidade de conexão da UI não contém projeto (risco condicional P0).**
`keyFor` gera `conn:<connectionId>` (`index.ts:51`) e `resolveSpec` usa ID numérico ou `id@database` (`api.ts:222`).
Metadados podem residir em SQLite por projeto (`server/project-feature-store.ts:18`; `store/db-split/manifest.ts:86`) com IDs autoincrement locais (`migrations/174_db_client.ts:32`).
Quando o roteamento por projeto está ativo, IDs iguais em projetos distintos podem colidir no registry/cache global. Não foi inspecionada a ativação do split nesta instalação nem reproduzida colisão em runtime.
Exigir identidade composta por projeto, conexão e database antes de considerar seguro o uso simultâneo em múltiplas janelas/projetos.

**DB-F10 — edição e exportação não definem consistência suficiente (P1/P2).**
O DML usa somente a PK (`sql/dml.ts:50-88`), sem versão/original da linha; a UI pode sobrescrever mudanças concorrentes sem detectá-las.
Export/dump usam OFFSET e somente a primeira coluna da PK ou primeira coluna geral (`index.ts:645-706`), insuficiente para ordem única em chaves compostas e para snapshot consistente sob escrita concorrente.
São lacunas de contrato; perda concreta ou duplicação em banco real não foi reproduzida.

## 4. Requisitos obrigatórios

| ID | Requisito | Aceite observável |
|---|---|---|
| DB-01 | Scanner lexical com estados de strings, identificadores, comentários e delimitadores por dialeto; classificação desconhecida conservadora | DB-F01 e corpus adversarial falham antes do dispatch; valores normais continuam válidos |
| DB-02 | Resolver identidade e autorização no host usando projeto + conexão + database + revisão | IDs iguais em dois projetos não compartilham pool, cache, cancelamento ou histórico |
| DB-03 | `maxRows`, `maxBytes`, limite de célula e backpressure na aquisição | Consulta de fixture com milhões de linhas não materializa tudo para mostrar 200 |
| DB-04 | Deadline e cancelamento atravessam fila, aquisição, driver, cursor e serialização | Operação cancelada não inicia próximo statement; backend/worker e lease são liberados |
| DB-05 | Resultado distingue aplicado, rollback confirmado, aplicação parcial e desconhecido | Nenhuma falha de DDL ou commit incerto recebe mensagem falsa de rollback |
| DB-06 | Leases ativos e revisão monotônica de conexão | Sweeper não fecha operação ativa; rotação rápida invalida configuração anterior |
| DB-07 | Schema progressivo na origem com cache por revisão/escopo | Abrir uma tabela não exige varrer definições de todas as outras |
| DB-08 | Capacidades explícitas por engine/versão | UI e agente não oferecem atomicidade/cancelamento que o driver não possui |
| DB-09 | Edição com controle de concorrência otimista e contagem de efeito | Linha alterada ou removida desde a leitura gera conflito recuperável |
| DB-10 | Exportação/importação com job, progresso, cancelamento e consistência declarada | Chaves compostas não duplicam/omitem registros na fixture estável; cancelamento libera recursos |
| DB-11 | Paridade de schema, parâmetros, limite e outcome entre console, grid e agente | Mesma operação equivalente aponta para a mesma relação e retorna o mesmo estado |
| DB-12 | SQLite de usuário isolado do main; SQLite interno com tarefas pesadas isoladas | Consulta pesada não impede interação/cancelamento da IDE |
| DB-13 | Telemetria por estágio sem segredos ou linhas completas por padrão | Atraso é atribuível a fila, conexão, servidor, fetch, serialização ou UI |
| DB-14 | Preservar recuperação e permissões em qualquer ferramenta/batch | Resultado de escrita desconhecido não é repetido automaticamente |

## 5. Contratos propostos

Os tipos abaixo são normativos para o desenho, não APIs implementadas. Evoluir contratos compartilhados e adaptar temporariamente chamadas legadas.

```ts
type DbTarget = {
  projectId: number;
  connectionId: number;
  database?: string;
  schema?: string;
  connectionRevision: number; // sem credenciais
};
type DbRequest = {
  requestId: string;
  target: DbTarget;
  statement: { sql: string; params: unknown[] };
  deadlineAtEpochMs: number; // absoluto; timeout de entrada convertido uma vez no host
  limits: { maxRows: number; maxBytes: number; maxCellBytes: number };
};
type DbOutcome =
  | 'read_completed' | 'applied' | 'rolled_back'
  | 'partially_applied' | 'not_dispatched' | 'unknown';
type DbPage = {
  requestId: string;
  fields: Array<{ name: string; type: string }>;
  rows: unknown[][];
  returnedRows: number;
  observedRows?: number;
  totalRows?: number; // somente quando conhecido, nunca inferido do cap
  truncated: boolean;
  nextCursor?: string;
  outcome: DbOutcome;
  timing: { queuedMs: number; acquireMs: number; executeMs: number; fetchMs: number };
};
```

Cursor opaco vinculado à identidade, revisão, operação, owner e prazo; não expor SQL/segredos no token.
Não converter genericamente toda consulta em `SELECT * FROM (...) LIMIT`: isso pode alterar semântica, múltiplos resultados, locks e DML RETURNING.
Cada adapter deve oferecer cursor/stream real ou declarar limitação; uma adaptação materializante não pode alegar aquisição limitada.
Para mutações com RETURNING, separar drenagem/conclusão da operação de retenção das linhas; cap de exibição não pode cancelar inadvertidamente o commit.

`DbCapabilities` deve declarar `streamRead`, `cancelInFlight`, `transactionalDml`, `transactionalDdl`, `readOnlyEnforcement`, `schemaScope`, `explain`, `snapshotExport` e limites negociados.
Um booleano genérico `supportsTransactions` é insuficiente; capacidades dependem de operação, storage engine e versão quando aplicável.

## 6. Execução, pool e transações

1. Resolver target autorizado no host; conferir revisão/configuração; adquirir lease com prazo.
2. Validar SQL/command e classificar efeitos antes do dispatch, mantendo guardas nativas de read-only.
3. Reservar orçamento de fila/conexões e deadline total; reportar timeout de aquisição separadamente.
4. Aplicar scope somente na conexão fixada e restaurá-lo ou descartar a conexão ao liberar.
5. Revalidar cancelamento/autoridade antes de cada statement, retry permitido e commit.
6. Emitir outcome com evidência suficiente; liberar cursor, conexão, listeners e metadados em todo caminho.

Scanner lexical não prova que toda função chamada por SELECT é sem efeito. Manter classificação semântica conservadora para funções/comandos desconhecidos e proteção nativa de read-only onde suportada. Quando a engine não puder impor essa garantia, declarar a limitação em capabilities e não apresentar filtro lexical como isolamento completo.

Cancelar PG/MySQL precisa de canal de controle que não fique atrás da fila saturada da própria operação; avaliar conexão dedicada/reserva e descarte após cancelamento tardio.
O registry deve rastrear `activeLeases`, `idleSince`, `opening`, `closing` e geração. TTL começa após a última liberação.
Rotação usa revisão monotônica persistida; limpeza de pool também remove `specCache` e `lastSeenVersion` correspondentes.

Batch transacional recebe lista parametrizada, conexão fixada, deadline total, limites de statements/bytes e modo `atomic_required` ou `best_effort` explícito.
`atomic_required` recusa operações incompatíveis antes de executar. Reads de snapshot usam transação read-only nativa, sem fallback silencioso para conexões independentes.
Não introduzir `BEGIN`/`COMMIT` soltos entre tool calls com checkout imprevisível do pool.
Propor `db_transaction` apenas para batch curto e fechado; validar a mesma política de efeitos de `db_query` e de chamadas internas via `code_exec`.
DDL com commit implícito exige preview e indicação da garantia disponível; não prometer compensação automática genérica.

## 7. Descoberta útil e experiência da IDE/agente

`db_schema` deve aceitar busca paginada no adapter, expandir relação exata diretamente quando schema está definido e retornar FK/índices sob demanda.
O renderer atual mostra colunas/PK, mas não todas as relações já disponíveis no driver; a nova resposta precisa oferecer o próximo passo sem inundar contexto.
Adicionar capacidade de explain estimado ao agente sobre a implementação existente; ANALYZE é execução e segue política própria.
Manter `db_query` para uma instrução e `db_command` para operações document/key-value; melhorar schemas específicos para evitar payload genérico sem exemplos válidos.

IDE: abrir tabela com identificadores corretamente qualificados; custom SQL deve herdar schema/deadline/cancelamento da aba.
Não descartar edições pendentes ao trocar página/filtro/recarregar sem ação explícita; `DataGridTab` hoje chama `revertAll` ao carregar resultado.
Desabilitar controles de edição em conexão read-only com razão visível, mantendo a guarda no host.
Mostrar tempo por estágio, truncamento por bytes/linhas, cursor disponível e estado de cancelamento real.
Schema/ER/diff grandes devem carregar partes, com progresso e cancelamento; falha de uma classe de objetos não deve parecer catálogo completo vazio.
Conflito de edição retorna chave, campos conflitantes e opções de recarregar/reaplicar; nenhuma repetição automática de escrita desconhecida.

## 8. Matriz de engines e validação

Esta tabela registra o código encontrado, não homologação de servidores nem versões instaladas.

| Engine | Aquisição atual observada | Cancelamento atual observado | Foco obrigatório |
|---|---|---|---|
| PostgreSQL | Materializa antes do slice | `pg_cancel_backend` por mesmo pool | Cursor, canal de cancelamento, batch/scope, schema homônimo |
| MySQL/MariaDB | Materializa antes do slice | `KILL QUERY` por mesmo pool | Stream, schema reset, DDL/commit implícito, storage engine |
| SQLite | Iteração limitada para reads, síncrona | Pré-dispatch/entre etapas síncronas | Worker/processo, prazo real, integridade após interrupção |
| SQL Server | Recordset completo antes do slice | `request.cancel()` | Streaming, deadline de batch, tipos e rollback confirmado |
| Oracle | `maxRows + 1` no execute | `connection.break()` | Scope, deadlines, DDL, tipos/LOB e resultado incerto |
| MongoDB | Cursor limitado em find/aggregate | Signal/maxTimeMS no driver | Bytes por documento, pipeline com efeitos, fechamento de cursor |
| Redis | SCAN para navegação; comando arbitrário pode materializar | Conferir por operação | Evitar KEYS/coleções enormes, bytes, SCAN não é snapshot |

Fixtures devem ser locais, descartáveis e sintéticas. Engines que dependem de infraestrutura/licença indisponível ficam explicitamente sem homologação, sem substituir a evidência por mocks.

## 9. Métricas e critérios quantitativos propostos

Metas iniciais para calibrar no benchmark comum da spec; não são medições atuais nem promessa sobre rede externa.

- Página interativa: default 200 linhas agente/100 grid; orçamento inicial de payload 1 MiB, com células grandes referenciadas como artefatos recuperáveis.
- Materialização: memória retida pelo fetch proporcional a no máximo duas páginas mais buffers do driver, comprovada em fixture de um milhão de linhas e células grandes.
- Cancelamento: UI reconhece pedido em até 100 ms; liberação local p95 até 2 s nas fixtures que suportam interrupção. Diferenciar pedido aceito de cancelamento confirmado.
- Responsividade: nenhuma query do usuário executa loop SQLite síncrono no main; p95 de event-loop delay do main abaixo de 50 ms durante fixture pesada.
- Metadata: primeira página quente p95 até 100 ms; fria local p95 até 1 s na fixture de 10 mil tabelas, sem descrever todas as tabelas.
- Filas: limites explícitos por conexão/projeto e total; testar cancelamento com pool saturado. Ajustar números após baseline, sem simplesmente aumentar pool.
- Correção: zero dispatch de mutação após revogação confirmada; zero mistura entre projetos; zero falso rollback; zero retry automático de `unknown`.
- Não registrar senha, DSN, chave TLS ou valores de parâmetros por padrão; métricas usam fingerprint de SQL e IDs escopados.

## 10. Plano de implementação e testes

| Etapa | Entrega | Evidência mínima de saída |
|---|---|---|
| DB-A / P0 | Scanner SQL, identidade composta, outcome de batch honesto | Regressões DB-F01/F04/F09; compatibilidade de chamada antiga |
| DB-B / P1 | Leases/revisões, deadline/cancelamento e scope consistentes | Saturação, rotação no mesmo segundo, cancelamento entre statements/commit |
| DB-C / P1 | Aquisição limitada PG/MySQL/MSSQL e SQLite fora do main | Benchmark de memória, primeira página e responsividade |
| DB-D / P1 | Catálogo incremental e paridade console/grid/agente | 10 mil tabelas, schema homônimo, catálogo parcial/obsoleto |
| DB-E / P2 | Concorrência otimista, export/import jobs e capacidades | Conflitos, PK composta, cancelamento, reinício e partial outcome |
| DB-F / release | Matriz engines + smoke Electron empacotado | Relatório explícito de passou/falhou/não executado por engine |

Estender testes existentes em `packages/db-drivers/src/__tests__/read-guard.test.ts`, `sql-dispatch.test.ts`, `manager-lifecycle.test.ts`, `sqlite-bounded.test.ts`, `mongo-bounded.test.ts` e `bounded-cursor.test.ts`.
Estender `packages/code-agent/src/tools/db/__tests__/scope.test.ts`, `schema-progressive.test.ts`, `outcome.test.ts` e `tools.integration.test.ts`.
Estender handlers em `packages/api-handlers/src/db-client/__tests__/flow.test.ts`, `limits.test.ts` e `query-timeout.test.ts`; adicionar contratos de bytes, schema read-only e batch não atômico.
Os testes reais `packages/db-drivers/src/__tests__/integration*.test.ts` são condicionados à infraestrutura/variáveis: suíte verde com skip não comprova engine real.
Executar jornadas visuais: conectar, buscar tabela, abrir schema não padrão, consultar/cancelar, editar com conflito, exportar/cancelar, desconectar e retomar.
Scanner: strings contendo comentários, comentários contendo aspas, escapes, identificadores, dollar-quoting quando aplicável, CTE de escrita, múltiplos statements e SQL incompleto.
Pool: três operações longas simultâneas, cancelamento, desconexão durante abertura, troca de projeto, revisão revogada e shutdown sem handles órfãos.
Falhas: conexão perdida antes do dispatch, durante statement, durante commit e durante rollback; cada caso deve produzir estado distinto quando existe evidência.

## 11. Migração, rollout e limites de conclusão

Adicionar revisão/identidade nos metadados internos de forma aditiva e compatível com store central e por projeto; preservar conexões, histórico e queries salvas.
Migrar chaves de sessão/cache/pool em memória com encerramento controlado; não reutilizar uma chave antiga ambígua entre projetos.
Adapters legados permanecem atrás de compatibilidade explícita; desabilitar temporariamente uma capability é preferível a declarar garantia inexistente.
Habilitar por engine e superfície, começando em fixtures; rollback desativa o caminho novo sem apagar configurações nem tocar dados do usuário.
Para SQLite interno, medir contenção, WAL, filas e long tasks antes de mudar pragmas; checkpoint, VACUUM e migração pesada continuam fora do main.
Não recuperar performance apagando índices, filas ou bancos sem plano de retenção/ownership específico aprovado para a implementação.
Conclusão requer evidência de contratos, benchmarks e uso real da IDE; builds e testes de builders isoladamente não provam responsividade, atomicidade remota ou segurança de todos os dialetos.
