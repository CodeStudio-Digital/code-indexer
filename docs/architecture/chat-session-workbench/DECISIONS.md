# Decisões vinculantes — Chat Session Workbench

> Alterações nestas decisões exigem atualização do spec afetado, do controle da
> etapa ativa e do histórico desta página.

## Registro

| ID | Decisão | Estado | Consequência |
|---|---|---|---|
| CSW-D001 | Refatoração por substituição, não por remendos no rail atual | Aceita | O caminho legado é retirado em S6 |
| CSW-D002 | Bundle filesystem continua autoritativo para estado de sessão | Aceita | Nenhuma nova tabela SQLite de rail |
| CSW-D003 | Um BFF/read model versionado serve o Session Workbench | Aceita | Painéis deixam de montar um mosaico de endpoints |
| CSW-D004 | Uma store normalizada por `sessionId` serve todas as superfícies | Aceita | Sem estado duplicado por mount |
| CSW-D005 | Snapshot e SSE usam revision/cursor e reducers comuns | Aceita | Reconciliação deixa de depender de eventos DOM |
| CSW-D006 | O rail terá seis destinos de produto, com subnavegação interna | Aceita | Redução da carga de 11+ ícones |
| CSW-D007 | Painel pesado é lazy; estado visual é preservado fora do componente | Aceita | Sem manter todos os painéis montados |
| CSW-D008 | Layout estreito usa overlay e mobile usa sheet rotulada | Aceita | Nenhuma ferramenta some abaixo de `lg` |
| CSW-D009 | Plugins entram pelo registry e mantêm o sandbox existente | Aceita | Sem caminho de renderização paralelo para plugins |
| CSW-D010 | Migração admite flag temporária apenas para cutover atômico | Aceita | Sem dual-write ou convivência indefinida |
| CSW-D011 | Worker Log é projetado e filtrado no backend | Aceita | Renderer não replica sampling/redação |
| CSW-D012 | Preferências de apresentação não pertencem ao banco de sessão | Aceita | Persistência fica na camada de preferência/layout |
| CSW-D013 | Conclusão exige remoção física do legado e grafo de imports zero | Aceita | “Novo caminho funcionando” não encerra o programa |
| CSW-D014 | Dados ainda não projetados usam disponibilidade discriminada | Aceita | Zero/array vazio não podem representar leitura não executada |
| CSW-D015 | Cada subview extensa possui cursor e revision independentes | Aceita | Trocar aba não materializa o domínio inteiro nem reutiliza cursor incompatível |
| CSW-D016 | O Workbench não cria compatibilidade para o domínio de pipelines retirado | Aceita | Summary permanece em goal/tasks/processes e segue os owners atuais |
| CSW-D017 | Gate de fonte usa HTTP efêmero quando o runtime instalado aponta para outro artefato | Aceita | Deploy/repackaging continua em S7 e não exige reinício sem efeito do app instalado |
| CSW-D018 | Total exato indisponível é `null`, nunca tamanho parcial da página | Aceita | Timeline e buscas permanecem honestas sem scan adicional não bounded |
| CSW-D019 | `commandId` UUID ancora receipt e target de duplicate | Aceita | Retry é deduplicável e duplicate pode retomar sem gerar segunda sessão |

## Decisões detalhadas

### CSW-D001 — Substituição arquitetural

Os componentes atuais podem servir como oráculo comportamental durante a
implementação, mas novos comportamentos NÃO DEVEM ser adicionados a eles para
“preparar” o refactor. Fronteiras temporárias são permitidas apenas quando
necessárias para comparação, cutover ou rollback.

### CSW-D002 — Autoridade de dados

O `FsSessionStore` e os bundles continuam responsáveis por conversa, estado,
Drive, planos, capítulos, métricas e artifacts da sessão. Catálogos globais de
provider, tool e skill mantêm seus owners atuais. O read model agrega essas
fontes sem criar uma nova autoridade.

### CSW-D003 — BFF do workbench

O frontend recebe um bootstrap pequeno e recursos paginados por domínio. O BFF
é uma projeção de leitura, não um segundo store. Responses DEVEM carregar
`sessionId`, `revision` e capabilities suficientes para rejeitar dados
obsoletos.

### CSW-D004/D005 — Estado e reconciliação

A store é indexada por `sessionId`; mounts diferentes observam selectors da
mesma entrada. Snapshot persistido nunca sobrescreve uma revisão viva mais
nova. Replay com `Last-Event-ID` preserva blocos anteriores ao cursor.

### CSW-D006 — Informação do rail

Destinos primários: Resumo, Contexto, Execução, Insights, Canvas e
Configuração. Snapshots são uma ação ampla do cabeçalho. Plugins aparecem em
grupo próprio.

### CSW-D010 — Migração

A flag pode escolher shell antigo ou novo por sessão durante o canário. Ela não
pode selecionar stores diferentes, produzir dual-write nem sobreviver ao gate
de retirada.

### CSW-D014 — Ausência não é zero

Bootstrap e resources pequenos podem adiar dados pertencentes a uma projeção
lazy. Nesses casos, o contrato publica `availability: pending` e um motivo
tipado. `0`, `[]` e `null` ficam reservados para resultados efetivamente lidos,
evitando que o frontend apresente ausência de leitura como estado confirmado.

### CSW-D015 — Paginação por subview

Contexto, Execução, Insights e Configuração são unions discriminadas por
`view`. Cursor codifica sessão, view, revision, offset e cursor do owner. Um
cursor nunca pode atravessar sessão, view ou revision; o cliente reinicia a
página quando recebe `stale_cursor`.

### CSW-D016 — Domínio retirado não ganha facade

O domínio de pipelines foi removido do produto por alteração concorrente. O
novo bootstrap não importa repository removido nem preserva campo morto no
contrato. Se um domínio equivalente voltar no futuro, entra como capability e
owner versionado, não como compatibilidade dentro do Workbench.

### CSW-D017 — Prova HTTP separada de deployment

O gate de código-fonte pode usar um servidor TCP efêmero que monte as rotas
reais e injete fixtures tipadas quando o processo instalado executa outro
artefato. Testes de integração continuam provando os owners reais. Reiniciar um
pacote que não importa a worktree não constitui prova; rebuild, packaging e
rollout são evidências próprias de S7.

### CSW-D018 — Contagem desconhecida não é parcial

`pageInfo.totalCount` e páginas de eventos aceitam `null` quando calcular o
total filtrado exigiria ler todo o journal. O frontend pode renderizar
paginação incremental, mas não pode apresentar `items.length` como total. Sem
filtros, o owner pode fornecer contagem exata de metadata.

### CSW-D019 — Identidade durável de comando

O `commandId` canônico identifica o receipt `workbench.command.applied` dentro
do bundle. Para duplicate, o mesmo UUID identifica a sessão alvo; replay de
mensagens usa operation IDs derivados de target/message seq. Assim um retry
após falha parcial retoma a mesma cópia. Reuso do ID com outro payload falha
fechado como conflito.

## Histórico de mudanças

| Data | Decisões | Motivo | Evidência |
|---|---|---|---|
| 2026-08-01 | CSW-D001..D013 | Criação do corpus inicial após aprovação do plano de refatoração completa | Specs deste diretório |
| 2026-08-01 | CSW-D003/D005 | Contrato público v1 materializado sem acoplá-lo ao handler legado ainda inexistente | `packages/api-bus/src/coder-session-workbench.ts` |
| 2026-08-01 | CSW-D014 | Bootstrap bounded não deve inventar contagens de eventos, snapshots, subagentes ou configuração | Evidência S1 |
| 2026-08-01 | CSW-D015 | Resources extensos precisam permanecer lazy e não compartilhar paginação incompatível | Evidência S1 |
| 2026-08-01 | CSW-D016 | Alinhar o contrato à retirada concorrente do domínio de pipelines sem introduzir facade | Evidência S1 |
| 2026-08-01 | CSW-D017 | Separar gate de fonte do deployment instalado e evitar restart sem efeito | CSW-E018 |
| 2026-08-01 | CSW-D018 | Evitar contagem fabricada em busca/filtro de journal bounded | CSW-E019 |
| 2026-08-01 | CSW-D019 | Garantir idempotência persistida e duplicate retomável | CSW-E020 |
