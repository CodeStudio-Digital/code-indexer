# Evidência S1 — read model concluído

> **Estado:** Concluída; G1 aprovado
> **Data:** 2026-08-01
> **Corte:** catálogo, lista, bootstrap e resources lazy

## Implementado

- `@mcp/api-bus` expõe o contrato v1 sem campos `unknown`/`any`, incluindo
  query, página, grupos, capabilities, resources, eventos e comandos.
- `FsSessionWorkbenchProjection` consulta o `SessionCatalog` em memória,
  filtra/ordena/agrupa antes de hidratar bundles e calcula `queryRevision`.
- `SessionWorkbenchQueryService` emite cursor opaco ligado à revisão e rejeita
  cursor stale, malformado ou fora do conjunto.
- `GET /api/coder/session-workbench/sessions` valida o boundary, limita páginas
  a 100 itens, retorna erro estruturado e publica ETag da revisão.
- `GET /api/coder/session-workbench/sessions/:id/bootstrap` agrega identidade,
  summary, capabilities, badges, revisions e projetos vinculados.
- Lista e bootstrap aceitam `If-None-Match` e respondem `304`; requests
  concorrentes idênticos compartilham uma promise em mapa limitado a 64 chaves.
- Destinos de plugin são projetados do registry declarativo existente, com a
  mesma regra de activation por root e sem executar código do plugin.
- A rota está montada antes das rotas de sessão legadas, mas não exige mudança
  nelas nem cria facade/dual-write.
- Contexto expõe `files|skills|chapters|plans|drive`; Execução expõe
  `timeline|subagents|processes`; Insights e Configuração têm views próprias.
- Cada view extensa tem paginação/cursor/revision independente. Cursor de outra
  sessão, view ou revision é rejeitado.
- Timeline fica explicitamente `event_projection_pending`; o owner canônico de
  journal/replay será materializado em S2.
- O boundary valida envelopes e itens aninhados antes do JSON. Violações internas
  falham fechadas com `invalid_response` e caminho seguro do campo.
- Catálogo de skills usa SQL metadata-only e não seleciona `prompt_body`.
- Inputs de telemetry não devolvem conteúdo; somente metadata redigida.
- Tool stats percorre `conversation.jsonl` em streaming reverso, aplica markers
  de rollback e não chama `readConversationSync`.

O estado de badges da linha é explicitamente `availability: pending` até S2
projetar eventos/notificações. O endpoint não inventa contagens zero. Liveness
usa o worker pool existente; detalhes ainda indisponíveis usam `null`.

## Prova de bootstrap bounded

O bootstrap lê uma vez cada owner resumido: sessão, goal, tasks e contagem de
capítulos. O teste dispara duas chamadas
concorrentes para a mesma sessão e comprova uma única passagem pela source.

- o JSON da fixture permanece abaixo de 10 kB;
- conversa, runtime-event journal, snapshots, inputs, tools e skills não são
  lidos no bootstrap;
- capítulos são um valor medido;
- contagens dependentes de events/snapshots/subagentes/configuração usam
  `availability: pending`, nunca zero fabricado;
- liveness/waiting vem do worker pool e falha para `null` sem quebrar a leitura.

## Prova de paginação antes da hidratação

O teste cria 120 entradas no catálogo, pede offset 10/limit 5 e verifica:

- `totalCount = 120`;
- cinco itens retornados;
- exatamente cinco chamadas a `getSession`;
- grupos calculados sobre os 120 itens;
- nenhum bundle fora da página é hidratado.

O teste de cursor também altera o título de uma sessão depois da primeira
página e comprova resposta `stale_cursor`. A revisão inclui identidade, título,
provider, model, workspace, updatedAt, favorite, archived, status e group.

## Prova dos resources lazy e owners

- troca de view não lê catálogo inativo de tools, inputs ou skills;
- chamadas idênticas concorrentes são coalescidas com limite de 64 chaves;
- capítulos preservam `total_count` e revision estável entre páginas;
- subagentes e task runs persistidos têm páginas bounded e revision finita;
- tools respeitam configuração de sessão e permission mode;
- plans sem título usam sua identidade de domínio, não chrome inglês;
- processos retornam `labelKey` de i18n, não string apresentada pelo backend.
- tool summaries mantêm somente agregados por nome em memória e um teste de
  rollback comprova que chamadas descartadas não reaparecem.

## Benchmark HTTP determinístico

```powershell
npx tsx benchmarks/session-workbench/read-model.mts
```

Resultado desta execução:

| Catálogo | Tempo | Response | Itens | Grupos | Bundles hidratados |
|---:|---:|---:|---:|---:|---:|
| 1.000 | 25,940 ms | 57.775 bytes | 100 | 40 | 100 |
| 10.000 | 63,922 ms | 57.796 bytes | 100 | 40 | 100 |

O benchmark monta a rota Hono real em processo e não abre storage do usuário.

## Validação

```powershell
npx vitest run `
  packages/api-bus/src/__tests__/coder-session-workbench.test.ts `
  apps/http-api/server/routes/coder/session-workbench/__tests__/query-service.test.ts `
  apps/http-api/server/routes/coder/session-workbench/__tests__/resource-service.test.ts `
  packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-crud.test.ts `
  packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-operational.test.ts `
  packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-history-metrics.test.ts `
  packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-operations.test.ts `
  packages/store/src/__tests__/skill-store-summary.test.ts
```

Resultado: **8 arquivos, 50 testes aprovados**. O corte específico de contrato,
query e routes soma **3 arquivos, 31 testes aprovados**.

```powershell
npm run build:dashboard
```

Resultado: aprovado, 6.154 módulos transformados em 14,22 s.

```powershell
npm run typecheck
```

Resultado atual: aprovado. Uma execução intermediária encontrou três referências
Company/pipeline removidas por alteração concorrente; após o owner externo
estabilizar o corte, a reexecução passou sem mudanças do Workbench nesses
arquivos.

```powershell
git diff --check -- <arquivos do Session Workbench>
```

Resultado: aprovado; somente avisos de normalização LF/CRLF.

```powershell
rg -n "session_workbench|SessionWorkbench|session-workbench" `
  packages/store/src/migrations
```

Resultado: nenhum schema ou migration SQLite do Workbench.

## Prova HTTP em socket e fechamento

```powershell
npx tsx benchmarks/session-workbench/live-smoke.mts
npx tsc --noEmit --pretty false
```

Resultado: servidor TCP efêmero em `127.0.0.1`, envelope `400 invalid_query` e
conditional GET `200/304` para lista, bootstrap e Context; typecheck aprovado.
O harness monta `mountSessionWorkbenchRoutes`, portanto cobre o boundary HTTP
real sem abrir storage do usuário.

O backend instalado em `:7333` permanece em `Program Files` e não importa o
código da worktree; seu 404 é defasagem de deployment, não falha desta fonte.
Reiniciá-lo não carregaria a rota sem rebuild/repackaging. O rollout desse
artefato pertence ao gate de release S7. Wiring RPC/Electron também só será
criado quando existir consumer real, evitando facade sem uso.
