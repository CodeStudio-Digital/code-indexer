# Auditoria do front-end React — 04/11/2026

## Conclusão

**O front-end tem otimizações importantes, mas ainda não está uniformemente otimizado.** Existem gargalos concretos de renderização, cópia de dados e encerramento de recursos. A medição anterior de CPU ociosa em projeto pequeno e chat vazio não exercitava essas situações; ela não certifica fluidez durante streaming, abertura de históricos grandes ou repetidas trocas de tela.

Duas execuções válidas em navegador confirmaram a diferença: a rodada viva com 2.000 blocos manteve somente 197 elementos DOM e não apresentou tarefas longas; a rodada persistida com 2.000 mensagens montou 22.031 elementos e bloqueou a thread principal por 817–985 ms na maior tarefa. Markdown de 100 mil caracteres também produziu atrasos relevantes durante atualizações. O maior custo observado está em parsing, renderização e DOM; houve coleta de lixo real, mas os ciclos curtos de montagem/desmontagem não demonstraram um vazamento genérico do React.

A suspeita de excesso de alocações é pertinente. Porém há três problemas diferentes nesta revisão: trabalho que recria arrays/strings para o coletor liberar; conteúdo que permanece alcançável além de sua utilidade; e assinaturas/timers que continuam após a saída do consumidor. A documentação do Chrome também distingue vazamento progressivo, excesso de memória e coleta frequente; determinar a contribuição de cada um exige observar memória e alocações ao longo do tempo. [Chrome DevTools — memory problems](https://developer.chrome.com/docs/devtools/memory-problems).

Esta rodada é **uma auditoria, sem alterações de produção**. Scripts e fixtures novos ficam em `.tmp/react-audit-2026-11-04/`. Nenhuma dependência foi atualizada, nenhum provedor/modelo foi chamado e nenhum banco real foi alterado. O instalador anterior `dist/electron-knowledge-fixes-20261104/CodeStudio Setup 3.15.7.exe` não incorpora correções dos novos achados abaixo.

## O que já segue boas práticas

| Área | Evidência no código atual | Efeito esperado e limite |
| --- | --- | --- |
| Separação de estado | `features/chat/messages/LiveMessageList.tsx` usa a assinatura estreita `useAgentCurrentTurn`; estado do stream tem dono fora do componente | Atualização de tokens não precisa renderizar o shell, compositor e sidebar inteiros; ainda pode haver trabalho excessivo dentro da lista |
| Editor | `features/workspace/EditorPane.tsx:135` seleciona o arquivo ativo; `state/workspace.ts:855` marca dirty sem copiar o texto integral por tecla | Reduz notificações e cópias por digitação; conteúdo canônico permanece no Monaco |
| Seletores estáveis | `state/company/selectors.ts:20` tem fallbacks estáveis; pilhas de abas usam `useShallow` | Evita snapshots novos sem alteração semântica |
| Virtualização | `MessageList.tsx` e `DiffRowsView` usam TanStack Virtual | Limita linhas em casos normais, mas perde eficácia quando uma linha reúne uma rodada inteira |
| Streaming cooperativo | `openStream` cede após 50 eventos/6 ms; projeção publica por animation frame; markdown vivo tem throttle de 80 ms | Limita frequência e deixa oportunidades para input; não limita o custo individual de um parser ou componente enorme |
| Carga sob demanda | Rotas de `App.tsx:45` e Monaco em `EditorPane.tsx:42` são lazy; detalhes de ferramentas/anexos são carregados sob demanda | Monaco/Shiki não fazem parte da árvore estática inicial do HTML |
| Recursos limitados | Monaco tem LRU de 20 modelos inativos; xterm tem scrollback de 5.000 linhas; cache de sessões ociosas tem limite 8 | Há políticas reais de retenção; fluxos ativos/rascunhos precisam de regras próprias |
| Polling/tempo compartilhado | `polling-controller.ts` cancela corretamente e pausa documento oculto; `shared-clock.ts` compartilha relógio de 1 Hz | Evita um timer por cartão; alguns consumidores ainda têm implementações locais incorretas |
| Contexto e requisições | `dialog-provider.tsx:72` memoriza o objeto de ações; GETs têm deduplicação | O uso de Context não implica rerender global obrigatório, e unmount individual não deve abortar a leitura compartilhada de outro consumidor |
| Navegação | `ProjectPrimarySurface.tsx:34` retém no máximo duas superfícies principais | Limita árvores quentes; esconder a anterior ainda não suspende o trabalho React dela |

Os caminhos abreviados desta tabela são relativos a `apps/dashboard/`.

## Achados e prioridade

P1 significa corrigir primeiro por risco de bloqueio relevante ou recurso que continua operando sem consumidor. P2 indica custo evitável ou falha de lifecycle em um fluxo específico. Prioridade não equivale a percentual de CPU medido no perfil do usuário.

### F01 — P1: o transporte Electron não encerra o iterator quando o consumidor sai

`apps/electron/preload.ts:121` implementa `return()` apenas com `ended=true`. A porta continua aberta; `onmessage` em `:78-85` não respeita o término e pode continuar enfileirando frames; leituras em espera em `:115` não são resolvidas. O produtor em `apps/electron/src/handlers-mount.ts:144-195,256-296` é abortado pela vida do renderer, sem vínculo completo com o fechamento dessa assinatura.

Esse caminho é real: `apiStream` → `electronOpenStream` → `window.electronAPI.openStream` → `openApiStream` → `openStream`. Tanto o stream compartilhado quanto `SingleTerminal` tentam chamar `return()` na limpeza. Portanto o componente tem cleanup, mas o transporte não cumpre sua parte.

**Reprodução:** a função exata extraída por AST apresentou zero `port.close()` após `return`, manteve um `next()` pendente e aceitou um frame posterior como `done:false`. A prova usa porta sintética, não uma estimativa de heap ou CPU do Electron instalado. Uma assinatura duradoura pode conservar fila, closures e trabalho sem consumidor.

### F02 — P1: agrupamento de histórico transforma milhares de mensagens em uma linha virtual

`apps/dashboard/features/chat/chat-message-grouping.ts:113` une grupos consecutivos do assistente antes de montar as linhas virtuais. `messages/MessageList.tsx:575,669` passa o grupo inteiro para `GroupedToolBubble.tsx:82`, que monta todos seus conteúdos. Assim a lista pode ter virtualização e, mesmo assim, uma única linha carregar milhares de mensagens/blocos. Uma mensagem individual com muitos blocos também fica sem limite interno.

A união repete spread de três arrays crescentes. **Prova pura:** 5.000 mensagens do assistente viraram um único grupo; só a fusão consumiu mediana de 85,18 ms e máximo de 90,44 ms no Node, com 37.507.497 posições de array copiadas cumulativamente. Isso não é o tempo de renderização no navegador nem bytes de heap.

**Gatilho:** carregar muitas páginas antigas de uma mesma solicitação ou expandir um capítulo. A abertura normal usa `tail=40&detail=preview` (`AgentChat.tsx:320`); não se afirma que todo chat carrega 5.000 mensagens na entrada.

**Confirmação no navegador:** a fixture com a lista real e viewport limitado montou 5.531 elementos DOM para 500 mensagens e 22.031 para 2.000, mantendo apenas três linhas virtuais. As maiores tarefas da montagem foram, respectivamente, 239–323 ms e 817–985 ms nas duas execuções. A granularidade do grupo anulou o benefício esperado da virtualização nesse cenário.

### F03 — P1: frames de texto reprocessam patches antigos da rodada viva

`MessageList.tsx:752` calcula `liveEditRefs` com dependência de `currentTurn`. O projetor cria um novo wrapper a cada publicação por frame (`hooks/agent-stream/turn-projector.ts:119`), mesmo quando os patches anteriores não mudaram. O cálculo percorre as ferramentas e divide novamente cada payload de `apply_patch` em linhas (`messages/edit-tools.ts:42`). Isso acontece mesmo enquanto o resumo final não está exibido. `FileEditBlock.tsx:21` também chama o parser durante render.

**Prova pura:** 100 patches de 1.000 linhas reprocessam 1,706 MB por passagem, com mediana de 7,15 ms/máximo de 14,85 ms; 200 patches reprocessam 3,413 MB, com mediana de 13,65 ms/máximo de 25,11 ms. São tempos do parser real no Node, não tempos de frame do Chromium. O custo cresce com alterações já concluídas, embora o evento novo seja apenas texto/pensamento.

### F04 — P2: o bridge de plugins perde o dono do stream no fechamento

`apps/dashboard/features/workspace/webview-bridge.ts:79-82` aborta apenas um controller local. Ele é consultado depois do próximo `next()` (`:113-116`), não cancela o transporte nem chama `return()` imediatamente. `webview-frame-registry.ts:26-27` só remove a identidade; a desmontagem de `WebviewWindow.tsx:65-73` só faz unregister.

**Reprodução:** fechamento deixou leitura ociosa pendente e zero chamadas a `iterator.return`; após unregister, um frame ainda foi encaminhado ao objeto de janela removido. O encerramento específico do plugin precisa ser corrigido junto com F01; uma camada não substitui a outra.

### F05 — P2: polling de túneis pode renascer após desmontar

`apps/dashboard/features/ssh/tunnels/TunnelsPanel.tsx:94-105` agenda o próximo timeout depois de `await tunnelList()` sem revalidar que o efeito continua vivo. O cleanup em `:109` limpa somente o timer conhecido naquele instante.

**Reprodução:** durante uma consulta pendente, cleanup deixou zero timers; a resposta tardia criou um timer novo após desmontagem. A reprodução usou o callback real e relógio/transporte sintéticos, sem conexão SSH.

### F06 — P2: expiração do cache não implica liberação dos corpos

`apps/dashboard/lib/api-cache.ts:34` declara TTL de 1.500 ms, mas a varredura só ocorre em novo sucesso de dedupe com pelo menos 64 entradas (`:63-68,96-99`). Uma leitura limpa apenas a chave lida; mutações limpam tudo. Sem novas ações, até 63 entradas expiradas podem ficar alcançáveis indefinidamente; 64 tampouco é teto rígido para bursts dentro do TTL, e não há orçamento em bytes.

**Reprodução:** oito corpos sintéticos de aproximadamente 4 MiB continuaram alcançáveis após 60 s de relógio e GC; após invalidar o cache, nenhum dos oito permaneceu. É retenção desnecessária comprovada, não prova de crescimento infinito da memória do aplicativo.

### F07 — P2: chat oculto continua recebendo atualizações e fazendo polling

`apps/dashboard/features/project/ProjectPrimarySurface.tsx:63-93` esconde a superfície anterior apenas por `opacity-0 pointer-events-none`. `ChatSurface` não recebe um contrato de visibilidade (`:135-146` e `tabs/ChatSurface.tsx:12-39`). `LiveMessageList.tsx:37` mantém sua assinatura. Colaboração/followups ainda consultam a cada 5 s enquanto o documento está visível, o que não distingue o chat oculto do editor ativo.

**Caminho confirmado por código:** trocar do chat em streaming para o editor deixa o chat como superfície quente. Na fixture, a lista real escondida pelo mesmo mecanismo de opacidade continuou fazendo 120 commits durante 120 atualizações, em ambas as execuções. Isso comprova o trabalho visual oculto; a participação desse fluxo na CPU total do aplicativo continua sem percentual atribuído. Manter o transporte e os dados vivos é apropriado; manter toda a projeção visual oculta ativa não é necessário.

### F08 — P2: expandir capítulo drena todas as páginas e conserva a fonte ao recolher

`MessageList.tsx:522,554,586` carrega páginas de 100 até acabar, só publica depois de reunir tudo e guarda os dados em `chapterSources`. Recolher muda apenas `expanded`. A projeção é recalculada para todas as fontes retidas quando esse mapa muda, incluindo capítulos recolhidos (`conversation-chapter-index.ts:65`).

É uma constatação de fluxo de controle, sem medição de rede/heap dessa navegação nesta prova. Repetir a expansão em capítulos extensos aumenta retenção e trabalho em dados que já não estão visíveis.

### F09 — P2: preview Company faz cópia quadrática para mostrar 80 caracteres

`state/company/stream-handlers/agentEvent.ts:148` copia todos os `textChunks` a cada delta. `features/agents/AgentPane.tsx:43` junta o texto inteiro e `:107` exibe somente os 80 caracteres finais. O consumidor de apresentação desse array localizado no dashboard é esse preview.

**Prova do reducer real:** 5.000 deltas: mediana de 26,99 ms; 10.000: 107,56 ms e 49.995.000 referências copiadas. Com a expressão de preview executada a cada passo, as medianas são 112,30/414,14 ms. Isso demonstra a escala; o React pode agrupar renders, portanto o segundo cenário não representa a frequência real de commits. Spread copia referências das strings, não todos os bytes de cada string. O pump cede a cada 50 eventos, mas ainda executa o reducer em todos eles.

### F10 — P1: uma mensagem Markdown muito grande ainda é trabalho síncrono

`messages/live-blocks.tsx:29,40` reduz frequência com throttle/defer; `Markdown.tsx:45` ainda entrega o texto acumulado inteiro ao parser síncrono. Preview de código e guarda de 50 mil caracteres no highlight acontecem depois do parsing do Markdown e não limitam a AST/DOM da mensagem completa.

**Confirmação no navegador:** 24 atualizações em uma mensagem de 100 mil caracteres provocaram 28–30 tarefas longas, com máximo de 438–454 ms para concluir a interação de digitação automatizada. O trace registrou 116–122 eventos Minor/Major GC, somando 379–388 ms ao longo do cenário; parsing/renderização/DOM ainda foram o custo dominante. Esses números não são INP nem duração de um único frame de GC.

Não se deve inferir vazamento dessa construção. O problema é que prioridade adiada não interrompe uma única chamada longa de parser. A correção precisa preservar a semântica de fences, tabelas e blocos incompletos do streaming.

### F11 — P2 preventivo: faltam guardas automáticas específicas de React

Não foi localizado script/configuração de ESLint ou `eslint-plugin-react-hooks` no checkout auditado; `.github/workflows` estava vazio. Existem TypeScript, Vitest, Playwright e verificações arquiteturais, que são valiosos, mas não substituem validação de regras/dependências de hooks. `main.tsx:37-50` desliga StrictMode globalmente por uma incompatibilidade documentada de lifecycle do Monaco.

Isso é uma lacuna de prevenção, não uma causa medida de CPU. O plugin oficial cobre regras de hooks, dependências e outros diagnósticos de pureza/imutabilidade, inclusive sem adotar o React Compiler. A adoção pode ser gradual. [React — eslint-plugin-react-hooks](https://react.dev/reference/eslint-plugin-react-hooks).

O React Compiler não está configurado no Vite atual. Sua ausência não é defeito por si só; não resolveria uma fila não encerrada, um parser síncrono gigante ou uma linha virtual sem limite.

## Pontos adicionais que ainda pedem reprodução

- **Rascunho de sessão excluída:** `composer-draft-store.ts` retém texto/anexos base64; os caminhos de exclusão de sessão em `AgentChat.tsx:1194-1272` não limpam esse draft. O flush de `useComposerDraft.ts:91-96` na desmontagem pode ressuscitá-lo se a limpeza for feita na ordem errada. Preservar rascunho ao navegar é intencional; sessão excluída requer lifecycle distinto.
- **Contexto Studio:** seleções/anexos por projeto em `studio-context-store.ts` não têm orçamento global. Capturas base64 podem pesar; falta medir cardinalidade/uso real antes de descartar qualquer contexto não enviado.
- **Ícones:** cache por nome em `material-icons/resolve.ts:55-65` não tem limite. Valores pequenos e URLs compartilhadas tornam esse ponto prioridade menor, sem evidência de que provoque travamento.

## Medições no navegador

Foram concluídas **duas execuções válidas**, com React 19.2.5 em build de produção com profiling, Chromium 149 e janela de 1.280 × 800. A fixture usa os componentes e a projeção reais, dados sintéticos, providers necessários e CSS do dashboard. Antes de medir listas, verifica viewport limitado de 760 px e `overflow: auto`. Os intervalos abaixo são o mínimo e o máximo entre as duas execuções; não são intervalos de confiança nem percentis populacionais.

| Cenário | Resultado observado | Interpretação |
| --- | --- | --- |
| Histórico com 20 mensagens | 251 elementos DOM; nenhuma tarefa longa na montagem | Caso pequeno permanece leve |
| Rodada viva com 2.000 blocos | 25 linhas virtuais, 197 elementos DOM; nenhuma tarefa longa no streaming; p95 dos intervalos de frame de 17,6–17,8 ms | A virtualização da rodada viva funciona nesse cenário |
| Mesma rodada viva oculta | 120 commits para 120 atualizações em cada execução | Opacidade não suspende a renderização |
| Histórico com 500 mensagens | Três linhas virtuais, 5.531 elementos DOM; maior tarefa da montagem de 239–323 ms | O grupo interno cresce apesar da virtualização externa |
| Histórico com 2.000 mensagens | Três linhas virtuais, 22.031 elementos DOM; maior tarefa da montagem de 817–985 ms | Travamento reproduzido na thread principal |
| Markdown de 100 mil caracteres, 24 atualizações | 28–30 tarefas longas; maior duração de interação automatizada de 438–454 ms; 116–122 eventos de GC, 379–388 ms cumulativos | Parsing/renderização/DOM dominam; coleta de lixo também contribui |

Em seis ciclos de montagem/desmontagem com GC forçado, o heap usado ficou aproximadamente em **6,72–6,73 MiB no primeiro ciclo e 6,78–6,79 MiB no último**. Os contadores permaneceram em um documento, 1.468 nós e 270 listeners. Esse recorte curto não mostrou crescimento progressivo relevante das árvores React; não exclui vazamentos de sessão longa, nem invalida as falhas específicas de transporte/cache reproduzidas separadamente.

A medição de digitação inclui automação e espera pela resposta do input. **Não é INP, certificação do aplicativo inteiro ou medição com um provedor real.** O profiling acrescenta algum custo, e dados reais podem variar. O resultado demonstra os mecanismos e sua diferença entre cenários controlados; não atribui toda a CPU ociosa do CodeStudio a esses pontos.

As duas primeiras montagens da fixture foram invalidadas: uma não incluía `TooltipProvider` e a outra não produzia o CSS Tailwind com a raiz isolada. Foram excluídas integralmente dos números publicados. As duas execuções substitutas concluíram com sucesso, screenshots verificadas e browser fechado. A checagem de identidade confirmou que nenhum processo pertencente à prova permaneceu; um PID reutilizado por outro processo foi preservado.

Os microbenchmarks anteriores são reproduções pequenas de funções reais e mantêm seu valor para custo algorítmico; não devem ser somados nem apresentados como duração de um frame do Electron. As provas de lifecycle transpilam o código atual em memória e substituem só relógio/transporte, sem abrir conta, banco, SSH ou modelo reais.

## Tarefas ordenadas e critérios de aceite

| Ordem | Correção | Aceite verificável |
| --- | --- | --- |
| 1 — F01/F04 | Completar teardown de stream no preload/host e associar cada stream de plugin ao frame dono | `return()` idempotente fecha porta, limpa fila, resolve waiters e rejeita frames tardios; cobrir retorno antes da transferência da porta e leitura pendente; ciclos de subscribe/unsubscribe deixam contadores estáveis. Encerrar assinatura de terminal preserva o PTY e não cancela operação de negócio por acidente |
| 2 — F02 | Separar metadados da rodada da granularidade virtual; trocar fusão repetida por acumulação linear | Reexecutar os cenários de 500/2.000 mensagens; rodadas persistidas e mensagens com muitos blocos mantêm quantidade montada proporcional ao viewport/overscan; texto, ordem, ferramentas, aprovação, seleção/cópia e links de arquivo continuam corretos; duplicar entrada não produz escala quadrática de agrupamento |
| 3 — F10 | Limitar reprocessamento de Markdown assentado e o trabalho da cauda viva | Reexecutar a prova de 100 mil caracteres/24 atualizações com trace comparável e registrar redução das tarefas longas e do atraso de input; preservar fences, tabelas e blocos incompletos; separar parser, React, layout e GC; eventual worker só entra onde a medida justifica |
| 4 — F03 | Calcular metadados de edits por identidade/revisão da ferramenta, não por wrapper da rodada | Deltas somente de texto/pensamento não chamam novamente o parser de patches concluídos; status, novos edits e resumo final continuam atualizando corretamente |
| 5 — F05 | Migrar poll de túneis para lifecycle com disposed/abort após cada await | Resolver consulta após unmount/dependência trocada não cria timer; no máximo uma consulta ativa; start/stop dos túneis reais preservado |
| 6 — F06/F08 | Definir orçamento de cache e paginação incremental da fonte de capítulos | Corpos expirados podem ser liberados sem nova mutação; respostas grandes respeitam política; abrir capítulo mostra primeira página sem drenar tudo; recolher/alternar capítulos respeita orçamento sem apagar histórico durável |
| 7 — F07 | Passar visibilidade da superfície para projeções e polling | Chat oculto mantém transporte/estado mas não faz commits de transcrição nem polling visual durante as mesmas 120 atualizações; revelar recupera o estado atual; navegação não duplica transporte nem quebra Monaco. Não aplicar React Activity indiscriminadamente à integração imperativa atual |
| 8 — F09 | Guardar somente preview limitado ou estrutura de chunks com cópia limitada | 10 mil deltas deixam preview correto e estado de apresentação limitado; escala aproximadamente linear, sem copiar todos os chunks anteriores por delta; transcript canônico preservado |
| 9 — F11 | Adicionar lint de hooks e regressões de lifecycle/DOM/heap às verificações habituais | Regras ativas com baseline explícita sem ampliar silenciosamente exceções; efeitos compatíveis exercitados com StrictMode/testes de remount; guardas impedem retorno dos cenários anteriores |
| 10 — adicionais | Encerrar rascunhos de sessões excluídas e orçar contexto Studio | Exclusão limpa dados órfãos sem flush ressuscitá-los; navegação comum preserva rascunhos não enviados; descarte/limites explícitos ao usuário quando houver risco de perda |

`memo`, `useMemo` e `useCallback` não devem ser aplicados indiscriminadamente. A recomendação oficial é medir a interação, manter lógica de render pura e estado o mais local possível; memoização pode ser anulada por props sempre novas e não é garantia de correção. [React — memo](https://react.dev/reference/react/memo). Da mesma forma, estado derivável não precisa de um efeito que o copie para outro estado e force um segundo ciclo de render. [React — You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect).

## Inventário do bundle existente

React/ReactDOM instalados: **19.2.5**; Zustand: **5.0.13**. A análise de imports/exports ESM estáticos do HTML construído encontrou **33 módulos e 757.575 bytes de JS não comprimido**, incluindo entrada de 569.823 bytes. Monaco/Shiki não fazem parte dessa árvore estática. Isso confirma divisão de código; não mede tempo de startup nem soma chunks carregados depois pela rota, traduções, CSS ou workers.

Exemplos sob demanda: `AgentChat` 426.296 B; `ProjectView` 234.306 B; `editor.api` 2.293.371 B; worker TypeScript 5.915.587 B. Um chunk superar o aviso genérico de 500 kB do Vite não demonstra sozinho o gargalo. A decisão de dividir mais deve partir do trace de carga/parse efetivamente utilizado.

## Evidências e reprodução

- `.tmp/react-audit-2026-11-04/summary.json`: consolidação das duas execuções válidas, hashes de evidências/fontes e limites da prova.
- `.tmp/react-audit-2026-11-04/browser/results/report.json` e `browser/results-repeat/report.json`: seis cenários em cada execução, Profiler, tarefas longas, CDP, GC e retenção após remount.
- `.tmp/react-audit-2026-11-04/browser/cleanup-identity.json`: verificação dos processos da prova por identidade, sem encerramento de processo alheio.
- `.tmp/react-audit-2026-11-04/render/findings.json`: caminhos, gatilhos e limites dos achados de render.
- `.tmp/react-audit-2026-11-04/render/pure-cost.json`: agrupamento e parsing de patches com funções de produção.
- `.tmp/react-audit-2026-11-04/lifecycle/report.md` e `probe-results.json`: quatro reproduções de cache, plugin, preload e túnel.
- `.tmp/react-audit-2026-11-04/architecture/company-delta-probe.mjs` e `.json`: escala do reducer e expressão de preview.
- `.tmp/react-audit-2026-11-04/architecture/bundle-graph.cjs` e `.json`: grafo estático do bundle já existente.

Não se declara que todos os travamentos do usuário vieram desses pontos, que todo crescimento de memória é vazamento, ou que o front-end inteiro foi certificado. O resultado demonstra que há boas práticas aplicadas e falhas relevantes ainda abertas. As tarefas acima são trabalho novo identificado nesta auditoria, separado das correções e do instalador entregues anteriormente.
