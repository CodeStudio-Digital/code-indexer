# Evidência S2 — projeção canônica de eventos

> **Estado:** primeiro corte concluído; S2 em andamento
> **Data:** 2026-08-01
> **Corte:** identidade, paginação, normalização, filtros e rota histórica

## Implementado

- novos eventos capturados no journal persistem o `busId` real do
  `CoderRunBus`; `seq` continua sendo a sequência original do bus;
- registros persistidos expõem página bounded em ordem descendente, com cursor
  opaco do owner e `revision` monotônica do entity journal;
- eventos legados sem `busId` recebem identidade determinística derivada do ID
  imutável do registro, sem regravar bundles antigos;
- `SessionWorkbenchEventService` produz a union pública
  `execution.event`, preservando `sessionId`, `busId`, `seq`, `revision` e
  timestamp do servidor;
- categoria, severidade, título, mensagem, duração e retryability são
  projetados no backend;
- a projeção não envia payload bruto; mensagens são redigidas e truncadas antes
  do boundary;
- busca, categoria e severidade são aplicadas server-side sem pular registros
  entre páginas;
- cada request examina no máximo 10.000 eventos e pode continuar pelo cursor;
- `GET /api/coder/session-workbench/sessions/:id/events` valida request/response,
  limita páginas a 500 e suporta `ETag/304`.
- a view `execution?view=timeline` consome essa mesma página e passa a responder
  `availability: available` no wiring de produção;
- contagem exata é `null` quando filtros exigiriam varredura integral, em vez de
  fabricar um total parcial.

Sampling, exclusão de deltas reconstruíveis e truncamento do payload bruto
continuam no único capturador backend `runtime-event-log`; o Workbench apenas
projeta esse journal, sem criar um segundo canal.

## Validação

```powershell
npx vitest run `
  packages/api-bus/src/__tests__/coder-session-workbench.test.ts `
  apps/http-api/server/routes/coder/session-workbench/__tests__/query-service.test.ts `
  apps/http-api/server/routes/coder/session-workbench/__tests__/resource-service.test.ts `
  apps/http-api/server/routes/coder/session-workbench/__tests__/event-service.test.ts `
  apps/http-api/sse/__tests__/runtime-event-log.test.ts
npx tsc --noEmit --pretty false
```

Resultado atual: **5 arquivos, 40 testes aprovados**, typecheck e diff check
aprovados.

Além do `busId` real sobreviver à escrita/leitura filesystem, um teste limpa
todo state process-local e comprova backfill do mesmo envelope após restart.

## Ainda aberto em S2

- mapear invalidations dos demais resources;
- implementar attach live/replay gap sobre o mesmo schema;
- exportar JSONL em streaming de uma passagem;
- projetar notificações duráveis e comandos read/dismiss;
- implementar o command service tipado, revisions e batch parcial;
- instrumentar métricas bounded e concluir os testes de reconnect/gap.

## Segundo corte: command service

- o boundary transforma JSON em comandos discriminados e limita batch a 100;
- rename, favorite, archive, move, duplicate e configuração de tool/skill são
  métodos explícitos, sem `execute(name, payload)` genérico;
- `expectedRevision` rejeita lost update, mas um retry cujo estado final já foi
  aplicado pode concluir o receipt sem repetir a mutação;
- `commandId` é UUID e identifica um receipt durável em `events/` dentro do
  bundle da sessão;
- reutilizar `commandId` com input diferente falha como
  `command_id_conflict`;
- chamadas concorrentes idênticas são coalescidas em memória e o receipt torna
  retries posteriores idempotentes após restart;
- batch executa em ordem e devolve sucesso/falha por item;
- cada commit bem-sucedido persiste o receipt antes de publicar invalidation
  tipada no hub bounded do Workbench;
- duplicate usa `commandId` como target UUID, operações de replay estáveis e
  capítulos idempotentes, podendo retomar sem criar segunda cópia;
- responses de comando também são validadas no boundary e falham fechadas.

Validação do segundo corte:

```powershell
npx vitest run `
  packages/api-bus/src/__tests__/coder-session-workbench.test.ts `
  apps/http-api/server/routes/coder/session-workbench/__tests__/command-service.test.ts `
  packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-operations.test.ts `
  packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-operational.test.ts
npx tsc --noEmit --pretty false
```

Resultado: **4 arquivos, 37 testes aprovados** e typecheck aprovado. Comandos
de notificação retornam falha tipada `command_not_implemented` até o owner
durável de unread/read/dismiss ser concluído; por isso `S2-008` e `S2-009`
permanecem parciais.

## Validação integrada após os dois cortes

```powershell
npx vitest run <11 arquivos focados do Workbench/filesystem>
npx tsc --noEmit --pretty false
npm run build:dashboard
```

Resultado: **11 arquivos, 72 testes aprovados**, typecheck aprovado e build do
dashboard aprovado com **6.155 módulos** em **8,27 s**. Os avisos de chunks
maiores que 500 kB permanecem baseline do dashboard e não foram introduzidos
como chunks novos do Workbench neste corte.
