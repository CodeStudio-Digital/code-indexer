# 06 — Migração, cutover e retirada do legado

## 1. Objetivo

Permitir construção e validação seguras sem converter a refatoração em
coexistência permanente ou série de patches no legado.

## 2. Estratégia

1. Congelar contrato comportamental e baseline.
2. Entregar backend novo ainda sem consumidor de produção.
3. Entregar store/controller novos com testes isolados.
4. Construir shell e painéis inteiramente no novo módulo.
5. Comparar outputs de leitura em ambiente de teste/shadow.
6. Ativar shell novo por flag temporária/cohort.
7. Validar todas as superfícies e fazer cutover padrão.
8. Remover flag, adapters e caminho legado.

- **CSW-MIG-001** — Não haverá dual-write.
- **CSW-MIG-002** — Shadow pode comparar responses, nunca executar comando em
  duplicidade.
- **CSW-MIG-003** — Flag escolhe shell completo, não componentes isolados.
- **CSW-MIG-004** — Rollback troca o shell para novas sessões/mounts; não
  corrompe runs já ativos.
- **CSW-MIG-005** — Toda flag tem owner, prazo e remoção em S6.

## 3. Compatibilidade temporária

Permitido:

- adapter read-only para transformar response antigo em fixture de comparação;
- endpoint v2 sem consumidor durante S1/S2;
- feature flag de seleção de shell;
- métricas paralelas de equivalência.

Proibido:

- novos recursos no `ChatRightRail` antigo;
- sincronização bidirecional de duas stores;
- dois attaches SSE para a mesma sessão no mesmo renderer;
- writes duplicados para garantir “compatibilidade”;
- deixar endpoint antigo sem consumidor por precaução indefinida.

## 4. Ordem de migração das superfícies

1. Harness isolado do workbench.
2. Chat de projeto.
3. Sessão global.
4. Editor compact rail.
5. Wrapper Coder do App Studio.

Cada superfície possui gate próprio; sucesso em projeto não promove global.

## 5. Inventário de retirada

S6 deve confirmar, por busca e grafo de imports, a remoção ou neutralização de:

- `ChatRightRail.tsx` legado;
- `RightPanelHost.tsx` e switch;
- estado/persistência `chatRightPanelId` dentro de `AgentChat`;
- blocos duplicados de portal/inline;
- fetch de chapters no rail;
- `worker-log-policy.ts` no renderer;
- store de Worker Log que represente segunda autoridade;
- eventos DOM `coder:drive_changed`, `coder:chapters-changed`,
  `coder:diagram_changed` e equivalentes;
- wrappers modais usados apenas por panels antigos;
- endpoints sem consumidores após a migração;
- traduções, testes e CSS mortos;
- feature flag e adapters de compatibilidade.

- **CSW-CUT-001** — Import graph do legado deve ser zero fora de fixtures/docs
  aprovadas.
- **CSW-CUT-002** — Build output não deve conter chunks exclusivos do legado.
- **CSW-CUT-003** — Nenhuma preferência persistida aponta para ID removido sem
  migração determinística.
- **CSW-CUT-004** — Arquivos antigos não podem permanecer como proxy do novo.

## 6. Rollback

Antes do cutover padrão:

- flag antiga ainda disponível;
- backend novo é additive e não altera bundles;
- layout preferences possuem migration reversível;
- run ativo mantém um único owner de stream;
- drill A → novo → antigo e A → novo → restart documentado.

Depois da retirada, rollback permitido é para a última build estável do novo
workbench. Não se reintroduz o caminho legado no branch principal.

## 7. Gate de conclusão de migração

- Todas as superfícies no novo shell.
- Zero dual-write/dual-attach.
- Flag removida.
- Grafo antigo zerado.
- Testes e build aprovados após deleção.
- Preferências antigas migradas.
- Release notes e runbook atualizados.

