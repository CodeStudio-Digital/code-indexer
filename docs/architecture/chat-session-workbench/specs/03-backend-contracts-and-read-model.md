# 03 — Contratos backend e read model

## 1. Objetivo

Criar uma fronteira backend coerente para o workbench sem transformar a
projeção em nova autoridade de dados.

## 2. Contratos compartilhados

Adicionar tipos e schemas versionados em `@mcp/api-bus` para:

- consulta e página de sessões;
- bootstrap do workbench;
- capabilities e badges;
- resources de Contexto, Execução, Insights e Configuração;
- cursores e revisions;
- eventos de sessão;
- comandos e erros estruturados.

- **CSW-API-001** — Nenhum campo consumido pelo workbench pode permanecer
  `unknown` no contrato público.
- **CSW-API-002** — IDs de sessão usam o branded `SessionId` existente.
- **CSW-API-003** — Requests e responses são validados no boundary HTTP.
- **CSW-API-004** — Erros têm `code`, `message`, `retryable` e contexto seguro.

## 3. Endpoints de leitura

### `GET /api/coder/session-workbench/sessions`

Query:

- `scope=project|global`;
- `project_id` quando aplicável;
- `cursor`, `limit`;
- `query`;
- `archived`, `favorite`, `status`, `provider`;
- `group_by=group|workspace`.

Resposta:

- items resumidos;
- groups e contagens totais;
- `nextCursor`;
- `queryRevision`.

### `GET /api/coder/session-workbench/sessions/:id/bootstrap`

Resposta pequena com identidade, capabilities, badges, estado resumido,
revisions e cursor de eventos. Não inclui listas extensas, logs ou turns de
telemetry.

### Resources sob `/:id`

- `/context?view=files|skills|chapters|plans|drive`
- `/execution?view=timeline|subagents|processes`
- `/insights?view=overview|usage|tools|inputs`
- `/configuration?view=skills|tools`
- `/events?cursor=&limit=&category=&level=&query=`

- **CSW-API-005** — Recursos extensos devem ser paginados.
- **CSW-API-006** — Todo response session-scoped carrega `sessionId` e
  `revision`.
- **CSW-API-007** — O servidor respeita limite máximo independente do cliente.
- **CSW-API-008** — O bootstrap não pode ler o JSONL completo de eventos.
- **CSW-API-018** — Cada subview extensa possui cursor/revision independente;
  cursor de outra sessão, view ou revision é inválido.
- **CSW-API-019** — Chrome localizado é responsabilidade do frontend. O
  backend retorna dados de domínio ou `labelKey`, nunca fallback inglês.
- Contagens exatas podem ser `null` quando filtros exigiriam varredura integral;
  um total parcial nunca pode ser publicado como total autoritativo.

## 4. Query service

`SessionWorkbenchQueryService` agrega owners existentes:

- `FsSessionStore` para sessão e records do bundle;
- catálogo de skills;
- metadata de tools/providers;
- worker pool para liveness;
- runtime event repository para diagnóstico persistido.

Regras:

- **CSW-API-009** — Uma requisição não deve abrir/ler o mesmo artifact mais de
  uma vez.
- **CSW-API-010** — Leituras concorrentes idênticas podem ser coalescidas.
- **CSW-API-011** — Cache é de projeção e curto; não substitui revision nem
  invalidação.
- **CSW-API-012** — Query service não pode escrever em bundle ou catálogo.
- **CSW-API-013** — Lista de sessões deve usar índice/catalog apropriado e não
  abrir todos os bundles para montar uma página.

## 5. Command service

`SessionWorkbenchCommandService` centraliza comandos usados pelos rails:

- rename, favorite, archive, move e duplicate;
- ações em lote;
- configuração de tools/skills;
- gestão manual de memória do Drive;
- read/dismiss quando a notificação for durável.

Transporte HTTP:

- `POST /api/coder/session-workbench/commands`;
- `POST /api/coder/session-workbench/commands/batch`.

- **CSW-CMD-001** — Cada comando valida a existência e o escopo da sessão.
- **CSW-CMD-002** — Mutação aceita `expectedRevision` quando houver risco de
  lost update.
- **CSW-CMD-003** — Batch retorna sucesso/falha por item; não mascara parcial.
- **CSW-CMD-004** — Comando bem-sucedido publica evento/invalidation tipado.
- **CSW-CMD-005** — Comandos não podem ser genéricos `execute(name,payload)`.
- **CSW-CMD-006** — Optimistic UI depende de idempotência ou chave de comando.

## 6. Ownership e persistência

| Dado | Owner |
|---|---|
| Sessão, estado, plans, Drive, capítulos | Bundle filesystem / `FsSessionStore` |
| Telemetry por turno | Metrics filesystem da sessão |
| Runtime events | Journal/JSONL da sessão |
| Catálogo de skills/tools/providers | Owners globais existentes |
| Layout e preferências visuais | Camada de preferência do dashboard/app |
| Cache do BFF | Memória bounded, descartável |

Nenhuma migration SQLite faz parte deste programa, salvo ADR explícita que
prove que o dado não pertence à sessão nem à preferência visual.

## 7. Exportação

- **CSW-API-014** — Export de eventos deve fazer uma única passagem sobre o
  journal.
- **CSW-API-015** — JSONL deve ser transmitido, não materializado integralmente
  no renderer.
- **CSW-API-016** — Resumo e metadata usam a mesma leitura ou índice persistido.
- **CSW-API-017** — Redação e truncamento são aplicados antes de qualquer byte
  chegar ao cliente.

## 8. Compatibilidade

Endpoints antigos permanecem apenas enquanto consumidores reais existirem. S6
deve produzir inventário de consumidores e remover endpoints exclusivos do rail
antigo. Compatibilidade sem consumidor não é motivo para retenção.
