# Índice estrutural, memória e snapshots — auditoria de 04/11/2026

## Parecer

| Recurso | Está sendo usado? | Recomendação |
| --- | --- | --- |
| Índice estrutural | Sim. Alimenta mapa inicial, ferramentas de símbolos/referências/dependências e FTS. O projeto da imagem possui uma base materializada coerente com os metadados dos arquivos. Há dois defeitos reproduzidos. | Manter e corrigir referências obsoletas e confirmação prematura de reconciliação. Medir utilidade em tarefas, além de cobertura. |
| Memória dos agentes | Sim. Há persistência, recuperação e montagem de contexto reais. A cobertura varia por agente/caminho e as métricas da UI não demonstram eficácia. A proteção contra conhecimento desatualizado falha no projeto inspecionado. | Manter; corrigir roteamento do banco, confirmação de extração, cobertura de busca e telemetria. Unificar a experiência de curadoria. |
| Snapshots de Contexto | É um sistema legado de notas, separado da memória ativa. Está vazio neste projeto e possui consumidores antigos. | Fundir a curadoria com a memória ativa e retirar a aba legada depois de preservar/migrar os dados. Conservar snapshots de arquivos, rodadas e ferramentas, que sustentam revisão e desfazer. |

**Resultado central:** a infraestrutura existe e funciona parcialmente; os selos e percentuais atuais prometem mais do que medem. Não há evidência suficiente para dizer que a memória melhora a conclusão de tarefas, nem para concluir que o índice não é usado porque “Resultados utilizados” mostra zero.

## Escopo e método

- Checkout atual de `D:/MCP`; rastreamento de produtores, armazenamento, consumidores, prompts, API e UI.
- Banco central e banco do projeto abertos com `readonly`, `fileMustExist` e `PRAGMA query_only=ON`, sem instanciar serviços que executam migrações.
- Agregados do projeto **Protomaker Hosp**, ID 10, correspondente aos 795 arquivos e 8.733 símbolos da imagem. Coletas em 04/11/2026, aproximadamente 14:30–14:41 no horário de Brasília. São observações pontuais de um aplicativo que pode continuar recebendo alterações.
- Nenhum conteúdo de memória, conversa ou nota real foi copiado para os relatórios. Foram usados contadores, hashes e metadados; os defeitos comportamentais foram reproduzidos com fixtures sintéticas.
- Testes focados em perfis temporários, um worker por lote. Sem consultas a modelos/embeddings remotos, reindexação real, instalação, publicação ou remoção de dados.
- Nesta etapa foram produzidos somente scripts, evidências e este relatório. As correções de produto abaixo **ainda não foram implementadas**. Não é uma nova certificação do aplicativo instalado ou da suíte completa do repositório.

## 1. Índice estrutural

### Evidência real

| Verificação | Resultado |
| --- | --- |
| Arquivos / símbolos / dependências no banco do projeto | 795 / 8.733 / 1.244 |
| Arquivos conferidos por tamanho e mtime | 795 de 795 coincidem; nenhum ausente |
| Símbolos sem arquivo / dependências com origem ou destino inexistente | 0 / 0 / 0 |
| Deltas estruturais persistidos pendentes | 0 |
| Geração semântica de código | 15.786 itens registrados como indexados de 15.786 esperados |

Tamanho e mtime iguais não certificam a correção de todos os parsers nem equivalem a recalcular cada hash de conteúdo. A integridade referencial também não detecta toda referência lógica obsoleta. Os 100% do semântico medem a geração esperada, sem demonstrar relevância dos resultados.

O mapa inicial é produzido por `packages/code-agent/src/core/repo-map.ts:12`: consulta até 80 arquivos recentes, com orçamento de 1.024 caracteres para o mapa. Ferramentas paginadas permitem aprofundar o contexto. `packages/code-agent/src/index.ts:2869` promove a prontidão durante o mesmo chat, e o primeiro turno pode começar em modo degradado sem bloquear aguardando indexação. A busca mantém fallback FTS.

### Defeitos confirmados

**I1 — P1: referências antigas sobrevivem à remoção da última chamada/importação.** Em `packages/indexer/src/indexer/indexer/process-file-structural.ts:146`, a substituição das referências só ocorre quando a nova lista tem elementos. A limpeza está dentro de `upsertSymbolReferences`; portanto uma lista vazia preserva os registros antigos. Uma fixture real Tree-sitter + SQLite terminou o incremento com `indexed=1/errors=0`, mas manteve duas referências a uma função que já não era importada nem chamada. Isso pode orientar uma análise de impacto incorreta.

**I2 — P2: a reconciliação manual pode confirmar o baseline anterior.** `packages/services/src/services/project-index/service.ts:184` inicia a passagem assíncrona; `ensureStructuralReady` pode encontrar o estado pronto anterior antes de começar o scan. A probe observou `ready` com `started=false/completed=false`. A rota em `apps/http-api/server/routes/project-detail-routes.ts:183` pode responder sucesso cedo. É necessário aguardar a conclusão da passagem solicitada, mantendo separada a disponibilidade do baseline para abrir chats rapidamente.

**I3 — P2: “Resultados utilizados” é um rótulo incorreto.** O contador agrega eventos `outcome=opened` emitidos pela busca/feedback da UI. Não há emissão equivalente do agente; mapa, skeleton, referências e dependências também não entram nesse total. Além disso, o caminho MCP FTS local perde `consumer/sessionId`. Zero não demonstra ausência de uso pelo harness. Referências do índice são baseadas em nomes; a precisão de compilador exige LSP/resolução semântica adicional.

A leitura agregada de `.mcp-indexer/metrics/semantic-search.jsonl` confirmou que **as 11 buscas dos últimos 30 dias foram registradas com `consumer=agent`** e escopo de sessão: nove `auto→fts` e duas `auto→hybrid`, sem eventos de outcome. Portanto há evidência histórica de consultas pelo agente, além da integração no código. O log tem retenção limitada e não cobre todas as ferramentas estruturais; não é prova de utilidade de cada resultado.

### Pontos fortes e limites

Há atualização incremental por hash, watchers/deltas, limites e paginação, publicação transacional com rollback e consulta estrutural sem provedor. São razões concretas para manter o índice. O mapa inicial por recência, a precisão das referências e o ganho do rerank/semântico precisam de avaliação por tarefas representativas. Não se deve aumentar o contexto ou ligar mais embeddings apenas para elevar contadores.

## 2. Memória dos agentes

### O que os dados mostram

| Métrica | Projeto | Global/usuário |
| --- | --- | --- |
| Memórias ativas | 263 | 219 |
| Memórias com acesso registrado nos últimos 30 dias | 64 | 0 |
| Memórias ativas com item indexado na geração vetorial ativa | 216 (82,1%) | 130 (59,4%) |
| Memórias ativas com falha registrada nessa geração | 14 | 50 |
| Memórias ativas sem item nessa geração | 33 | 39 |

A cobertura foi calculada ligando IDs de memórias **ativas** a `semantic_items` na geração ativa, sem confundir chunks, arquivadas e contadores antigos do namespace. É cobertura registrada; não certifica a qualidade dos vetores nem executa uma consulta real ao provedor. A falha ou ausência vetorial não apaga a memória: FTS e índices textuais continuam disponíveis. A causa das falhas vetoriais não foi determinada nesta auditoria.

Nos últimos 30 dias foram registrados **59 recalls, 44 não vazios**, com 173 itens contabilizados como retornados, incluindo repetições. O “recall com hit 75%” é 44/59; o “em uso 24%” corresponde aproximadamente a 64/263. Esses números não medem aplicação da memória nem melhoria de resposta.

“Memória do projeto: 0” conta a tabela legada `snapshots`; “263 no projeto” conta `agent_memory`. São bases diferentes exibidas juntas. “200 vivas” na lista decorre do limite de listagem sem paginação, e não significa que as outras 63 desapareceram. “Salvou 0” não inclui todos os caminhos de persistência automática/MCP. A data antiga de destilação também vem de uma trilha diferente das extrações de sessão atuais.

### Caminho funcional e capacidade disponível

`AgentMemoryWriter` persiste; `AgentMemoryRetriever` combina recuperação e ranking; o runner monta índice inicial e injeções relevantes. Existem deduplicação, importância, arquivamento e orçamento de contexto. O estoque em disco não equivale ao conteúdo disponível em cada turno:

- O host solicita até cinco memórias; a injeção dinâmica normalmente inclui até três e corta cada conteúdo a 300 caracteres. Receitas longas dependem de recuperação explícita completa.
- Preferências globais usam um índice curto e um bloco com orçamento padrão de 600 caracteres, menor em contextos pequenos. A seleção começa por no máximo 100 candidatos por importância, depois aplica ranking e devolve até 12; o bloco final pode conter apenas poucas preferências.
- O índice de preferências não marca acesso. Por isso, zero acessos globais não comprova que nenhuma preferência entrou no prompt.
- O `recall_memory` nativo consulta projeto; não oferece o mesmo caminho explícito de busca global disponível em outros fluxos. Subagentes de implementação não recebem os mesmos callbacks automáticos de memória do runner principal e dependem de contexto delegado/ferramentas. O comportamento não é uniforme entre agentes.

### Defeitos e lacunas confirmados

**M1 — P1: verificação de desatualização usa o banco errado após divisão por projeto.** `packages/store/src/db.ts:843`, `:846` e `:865` passam o banco central para captura/verificação de referências. `packages/store/src/db/agent-memory-references.ts:21` e `:142` consultam `files` nesse mesmo banco, enquanto os arquivos atuais estão no banco do projeto.

No caso real, o central conserva 755 arquivos antigos e o banco local possui 795: 53 arquivos locais não existem no central e 44 têm hashes diferentes. Das 263 memórias, 97 possuem referências; há 109 referências com hash-base e 49 sem hash-base. A comparação com o banco central sinaliza **zero** mudanças; com o banco atual sinaliza **79 referências em 56 memórias**. Essas 56 memórias deixam de receber o aviso que a proteção deveria produzir. Isso indica arquivos alterados/removidos, não prova que todo o conteúdo dessas memórias se tornou inválido. Reindexar sozinho não corrige o roteamento errado.

**M2 — P1: timeout de extração pode consumir um trecho sem aprendizagem confirmada.** `packages/code-agent/src/core/runner/compaction/memory-harvest.ts:139` usa uma corrida de 30 segundos e avança o marcador mesmo quando o resultado ainda não chegou. A probe fez a extração retornar erro depois do timeout: o trecho já estava marcado como consumido e não seria retomado pelo sweeper. O chat deve continuar, mas a confirmação de aprendizagem precisa de estado pendente/retry idempotente separado.

**M3 — P2: recuperação é registrada como se fosse injeção.** O retriever marca os cinco itens acessados antes da montagem final, que pode incluir três ou nenhum por deduplicação. As probes reproduziram ambos os casos. É necessário registrar o resultado efetivamente enviado ao modelo depois dos filtros, separando recuperação, injeção, uso explicitamente observado e resultado da tarefa.

**M4 — P2: orçamento pode descartar todas as preferências.** A montagem interrompe a iteração quando o primeiro item não cabe. Uma probe com orçamento de 200 caracteres mostrou um bloco vazio apesar de haver um item curto posterior que caberia. Deve-se tentar o próximo item ou usar uma representação menor, com omissão explícita e recuperação complementar.

**M5 — P2: persistência e KPIs usam contratos diferentes.** `apps/mcp-server/tools/snapshots.ts:41` salva na memória ativa sem o mesmo evento de `remember`/log de outras rotas; `packages/session-storage/src/fs-store/memory-kpis.ts` reconhece nomes antigos e não todos os atuais (`save_memory/search_memory`). Percentuais de “aprendizado” e contadores não devem ser apresentados como qualidade enquanto a cobertura de eventos for desigual.

**M6 — P2: custo recorrente de estatísticas precisa ser limitado.** O card chama `/agent-memory/stats` a cada oito segundos enquanto ativo; a rota volta a agregar bundles de sessões. Não foi medido como causa do consumo de CPU relatado. Recomenda-se cache incremental por revisão/evento e medição com históricos grandes, preservando a suspensão do polling quando a UI não está visível.

### Eficácia: resposta objetiva

**O harness usa memória e consegue persistir/recuperar conteúdo. Não está demonstrado que ela seja eficaz de forma consistente.** Há falhas de frescor, cobertura e confirmação de aprendizagem, além de métricas que não distinguem intenção de uso de contexto realmente enviado. Uma avaliação útil compara tarefas equivalentes com e sem memória, medindo correção, repetição de erro já conhecido, tokens, latência e contaminação entre projetos. Os percentuais da tela não substituem esse teste.

## 3. Snapshots: o que compensa retirar

**Compensa retirar a aba de notas legadas do fluxo principal depois da unificação; não compensa apagar todos os mecanismos chamados snapshot.**

| Família | Função atual | Destino recomendado |
| --- | --- | --- |
| `snapshots` de contexto | Notas SQLite, curadoria antiga, CLI/context, exportação e resource MCP | Migrar/preservar e integrar à memória ativa; depreciar os caminhos antigos |
| Memória `agent_memory` | Aprendizagem, preferências, recuperação e contexto do agente | Manter como superfície principal de conhecimento |
| Baseline de arquivos | Estado anterior para diff/revisão/desfazer | Manter |
| Snapshots de rodada/ferramenta | Atribuir mudanças à mensagem/chamada correta | Manter |
| Artefatos de revisão/recuperação | Integridade e retomada das decisões de revisão | Manter |

O projeto da imagem tem zero notas legadas, mas o perfil inteiro possui **16 ativas**. A migração existente não cobre todas as notas manuais nem preserva integralmente tags, versões e hashes. A exclusão direta perderia curadoria.

Defeitos adicionais:

- `SnapshotService.renderGrouped` em `packages/services/src/services/snapshots.ts:438` só renderiza seis categorias. A UI aceita oito; **gotcha/procedure são omitidas**. A probe confirmou a omissão e o inventário contém três notas nessas categorias. Em dois projetos, elas são a única nota, portanto esse caminho de contexto produziria somente o cabeçalho.
- `SnapshotEditor.tsx:50` ignora o erro inicial do GET; uma falha pode aparecer como “Nenhum snapshot ainda”. O projeto da imagem foi confirmado vazio por leitura do banco; não atribuímos sua tela a esse erro.
- Descrições MCP ainda citam `list_snapshots/query_snapshots`, ferramentas já removidas. A UI promete que pinar notas legadas reforça o contexto inicial, mas o caminho ativo consulta outra tabela.
- Consolidar/restaurar “memória” na superfície legada opera em snapshots, não no estoque ativo mostrado ao lado.

Não há medição que atribua CPU ociosa à aba vazia. Para os snapshots de alterações, existem oportunidades concretas a perfilar: leitura síncrona de blobs na listagem por ferramenta, materialização de conteúdo e hashes de arquivos grandes. O limiar que suprime diff grande não é teto de disco do conteúdo necessário ao rollback. Otimizar listagem por metadados/paginação e carregar blobs sob demanda deve preservar a capacidade de desfazer.

## Tarefas em ordem de execução

| Prioridade | Entrega | Critério de aceite |
| --- | --- | --- |
| P1 | Corrigir roteamento de hashes da memória para o banco proprietário do projeto | Fixtures com banco central vazio e antigo identificam mudanças corretas; dado sem baseline é exibido como desconhecido; 56 casos reais são reavaliáveis sem apagar memórias |
| P1 | Substituir referências estruturais inclusive quando a lista nova é vazia | Remoção total, rename e arquivo vazio não preservam ocorrências antigas; planejar reparo do estoque já afetado |
| P1 | Confirmar extração antes de avançar o marcador de aprendizagem | Timeout não perde trecho; erro tardio permite retry idempotente; chat continua responsivo |
| P2 | Aguardar a passagem manual de reconciliação | Endpoint só confirma aquela passagem após conclusão; erro/cancelamento/concorrência cobertos |
| P2 | Unificar cards e eventos de memória | Estoque e eventos vêm do mesmo store; distinguir recuperado/injetado/resultado; MCP e nativo têm cobertura equivalente |
| P2 | Reparar cobertura semântica com diagnóstico e retry limitado | UI expõe indexado/falhou/pendente por memória viva; falhas têm causa acionável; sem loop de retry nem chamadas remotas implícitas ao abrir projeto |
| P2 | Corrigir orçamento de preferências e alinhar os agentes | Item grande não bloqueia os menores; recuperação global explícita e subagentes têm contrato documentado/testado |
| P2 | Unificar curadoria e migrar notas legadas | Inventário/exportação verificáveis das 16 notas; migração idempotente sem perda silenciosa de categorias/history; criar/pinar nota altera contexto do runtime |
| P2 | Corrigir categorias omitidas, erro vazio e descoberta MCP | Todas as categorias exportam; erro mostra retry; nenhum tool inexistente é anunciado |
| P2 | Limitar custo das métricas e listas de histórico | Cache/eventos/paginação; medir p95 e CPU com históricos pequenos/grandes sem carregar todos os blobs |
| P2 | Avaliar utilidade do índice e da memória | Conjunto representativo com/sem memória e lexical/semântico; comparar tarefa correta, erros recorrentes, tokens e latência |
| P3 | Melhorar seleção do repo map e legibilidade dos indicadores | Ganho medido dentro de orçamento; UI distingue baseline disponível, passagem pendente e limites de precisão |

## Evidências e limites de validação

Os resultados finais dos lotes e o inventário de artefatos estão no JSON que acompanha este relatório. Provas que passam reproduzindo um defeito **não significam que ele foi corrigido**.

| Lote | Testes existentes aprovados | Provas adicionais |
| --- | --- | --- |
| Índice estrutural, publicação, readiness e telemetria | 80 em 11 arquivos | 2 |
| Memória, recuperação, extração e montagem | 181 em 19 arquivos | 6 |
| Snapshots de contexto/arquivos/rodadas/ferramentas | 35 em 6 arquivos | 1 prova do formatador real |
| Total focado | **296 em 36 arquivos** | **9** |

Os processos de teste registrados foram encerrados. O lote de snapshots usa o resultado final por teste: 25 passaram inicialmente e dez bloqueados por `EPERM` passaram no reteste host, sem duplicar a contagem.

- Agregados somente leitura: `.tmp/knowledge-audit-2026-11-04/live-aggregates.json` e `live-verification.json`.
- Origem das buscas: `.tmp/knowledge-audit-2026-11-04/search-aggregates.json`, sem consultas ou conteúdos de conversas.
- Índice: `.tmp/knowledge-audit-2026-11-04/structural/report.md`, resultados Vitest e probes de referências/readiness.
- Memória: `.tmp/knowledge-audit-2026-11-04/memory/` contém relatório, testes e probes.
- Snapshots: `.tmp/knowledge-audit-2026-11-04/snapshots/report.md`, resultados de regressão e `render-grouped-evidence.json`.
- Lotes inicialmente afetados por sandbox/EPERM ou configuração de filtro foram separados dos resultados finais. Não foram apresentados como falhas do produto.
- Não houve benchmark novo de CPU/UI, comparação de qualidade com modelo real, teste de todos os providers ou certificação da versão instalada. O relatório anterior de CPU/harness continua separado desta auditoria de conhecimento.
