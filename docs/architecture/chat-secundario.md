# Chat secundário no CodeStudio

Desenho, implementação e validação do chat secundário, 22 de novembro de 2026.

Uma pessoa acompanha o revisor trabalhando e seleciona a chamada `create_chat` para perguntar “Que modelo ele abriu e por que continua aguardando?”. A resposta aparece em um painel ao lado. A pessoa pode fazer outra pergunta, fechar o painel e retomar o rascunho que estava escrevendo no principal. O revisor continua a tarefa durante toda a conversa.

## Como os produtos de referência resolvem isso

| Produto | Experiência documentada | O que aproveitar |
| --- | --- | --- |
| Claude Code | No desktop, `/btw` abre um painel com o contexto do principal até aquele momento. As trocas ficam fora do histórico principal e o desktop as descarta ao encerrar o aplicativo. No terminal, a pergunta funciona durante a execução, usa mensagens e resultados já obtidos e pode recuperar perguntas laterais anteriores. | Responder com o que a sessão já sabe, inclusive enquanto o agente trabalha. [Desktop](https://code.claude.com/docs/en/desktop#ask-a-side-question-without-derailing-the-session) · [Terminal](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw) |
| Codex | `/side` abre uma conversa vinculada. Também é possível partir de um trecho selecionado. Na implementação pública do terminal, a conversa deriva do principal e o histórico herdado é marcado como material de referência. O código prevê armazenamento temporário ou vinculado, conforme a superfície e o suporte do servidor. | Âncora em uma mensagem, perguntas sucessivas e uma divisão explícita entre histórico consultado e instruções do novo chat. [Guia da OpenAI](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) · [Implementação do terminal](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/side.rs) |

## Uso no CodeStudio

- **Abrir.** Botão **Chat secundário**, comando `/side [pergunta]` com alias `/btw`, ou ação **Perguntar sobre este trecho**. O painel abre de imediato e aceita perguntas enquanto o pai transmite ou aguarda aprovação. Só enviar uma pergunta chama o modelo.
- **Conversar.** Uma conversa lateral por chat principal na primeira versão. Ela acompanha as próprias perguntas anteriores. O cabeçalho informa até qual mensagem do principal ela consegue ver. **Atualizar contexto** incorpora o progresso mais recente na próxima pergunta. Cada resposta conserva a referência ao contexto que usou.
- **Voltar.** Recolher o painel, trocar de sessão ou reiniciar o aplicativo permite retomá-lo pelo mesmo principal. O histórico é salvo no projeto ou no armazenamento global da sessão. **Limpar conversa lateral** descarta esse histórico. **Copiar resposta** deixa com a pessoa a decisão de como usá-la.
- **Alcance.** O modelo explica mensagens, resultados de ferramentas já exibidos e trechos selecionados. Se faltar a informação, identifica o que falta. Quem quiser encomendar uma ação continua podendo usar a delegação existente.

## Implementação em quatro etapas

### 1. Capturar o contexto correto

Criar uma leitura no armazenamento de sessões que devolva em uma única revisão consistente o identificador do principal, a revisão do diário, o limite de mensagens e o texto visível necessário. O backend deriva o conteúdo a partir da sessão autorizada e valida a origem de uma seleção. Para conversas longas, priorizar o trecho escolhido, o resumo de capítulos que já existia naquele ponto e as trocas recentes, até o orçamento do modelo. Resultados longos entram como extratos identificados. Informar ao usuário quando parte do histórico ficou de fora. [Leitor de conversas do CodeStudio](https://github.com/CodeStudio-Digital/code-indexer/blob/360ef068a765688b4bf8083f89b1c30a0a15290b/packages/session-storage/src/fs-store/conversation-reader.ts)

Materializar essa seleção uma vez e guardá-la com o chat secundário. O diário permite que a conclusão de uma resposta atualize a mensagem de mesmo `seq`. Consultar o número novamente em cada pergunta pode mudar a evidência depois de o usuário já ter perguntado sobre ela. Usar por padrão mensagens e resultados concluídos. Se a pessoa selecionar palavras de uma resposta ainda em andamento, conservar exatamente a citação visível e marcá-la como parcial.

### 2. Executar a conversa separadamente

Criar uma rota própria para os turnos laterais. Resolver o identificador exato do provedor, o modelo e o esforço efetivo do principal na abertura. Se esse destino ficar indisponível, mostrar o motivo no painel. Usar uma instância de adaptador, identificador de conversa, fluxo de resposta e cancelamento próprios. Nos provedores com continuação remota, a conversa lateral começa com o contexto capturado e mantém seus próprios identificadores de resposta nas perguntas seguintes. [Fábrica de provedores](https://github.com/CodeStudio-Digital/code-indexer/blob/360ef068a765688b4bf8083f89b1c30a0a15290b/packages/services/src/providers/factory.ts) · [Contrato de streaming](https://github.com/CodeStudio-Digital/code-indexer/blob/360ef068a765688b4bf8083f89b1c30a0a15290b/packages/provider-sdk/src/adapter.ts)

A chamada é de inferência de texto. Enviar `tools: []`, verificar o suporte a inferência sem execução e desativar ferramentas hospedadas na requisição do adaptador. O adaptador ChatGPT, por exemplo, pode acrescentar geração de imagem depois de receber a lista local. Quando o adaptador não conseguir garantir o modo de consulta, explicar a limitação antes do envio. As mensagens herdadas entram como referência identificada. Os únicos pedidos ativos são os da conversa lateral. [Ferramentas hospedadas no adaptador ChatGPT](https://github.com/CodeStudio-Digital/code-indexer/blob/360ef068a765688b4bf8083f89b1c30a0a15290b/packages/code-agent/src/providers/chatgpt.ts)

O `create_chat` existente cria um participante, liga caixas de mensagens e pode devolver o resultado ao pai. Esse caminho deve continuar atendendo ao trabalho delegado. O serviço lateral só precisa da leitura do principal, do provedor e do seu próprio armazenamento. Assim, até um erro de rede ou um cancelamento ficam contidos no painel. [Criação de agentes filhos](https://github.com/CodeStudio-Digital/code-indexer/blob/360ef068a765688b4bf8083f89b1c30a0a15290b/apps/http-api/server/routes/coder/child-agent-host.ts)

### 3. Integrar o painel e a retomada

Adicionar o painel ao `RightPanelHost` e oferecer a ação no texto do histórico. Interceptar os dois comandos no compositor antes de verificar skills, gravar menções, enviar ou enfileirar mensagens. Cobrir clique e teclado. O painel tem rascunho, rolagem e estado de transmissão próprios. O histórico principal continua selecionado. [Painéis do chat](https://github.com/CodeStudio-Digital/code-indexer/blob/360ef068a765688b4bf8083f89b1c30a0a15290b/apps/dashboard/features/chat/right-panel/RightPanelHost.tsx) · [Envio e fila no compositor](https://github.com/CodeStudio-Digital/code-indexer/blob/360ef068a765688b4bf8083f89b1c30a0a15290b/apps/dashboard/features/chat/composer/Composer.tsx)

Guardar a conversa em um espaço de dados próprio, com o mesmo escopo de acesso do principal. Vincular pelo ID da origem, inclusive em chats globais. Registrar cada pergunta com uma chave idempotente e associar sua resposta à versão do contexto. Isso permite reconectar o painel ou reabrir o aplicativo sem disparar a mesma pergunta duas vezes. Uma resposta interrompida pelo encerramento do aplicativo deve aparecer como interrompida. Aplicar as regras de exclusão do principal aos dados vinculados.

### 4. Validar no aplicativo

| Cenário | Critério de aceite |
| --- | --- |
| Principal em execução | Com a resposta principal pausada por um provedor de teste, abrir pelo botão e por `/side`, fazer duas perguntas e ver as duas respostas antes de liberar o principal. Conferir rascunho, fila, mensagens, aprovações e arquivos do principal antes e depois. |
| Falha ou cancelamento | Cancelar uma terceira pergunta e simular perda de conexão e limite de uso no secundário. O stream e o resultado final do principal continuam válidos. Reconectar mantém uma única cópia de cada pergunta. |
| Fidelidade ao contexto | Alterar uma mensagem de mesmo `seq` e compactar o principal após a captura. As perguntas laterais continuam usando a versão capturada até a atualização explícita. Verificar a citação selecionada mesmo se estiver fora das mensagens recentes. |
| Persistência e isolamento | Trocar de painel e de projeto, reabrir o aplicativo e descartar a consulta. Verificar histórico e rascunho corretos, escopo de acesso e ausência de mensagens laterais no catálogo de chats delegados, no histórico e na memória do principal. |
| Provedores e desempenho | Validar ChatGPT e Claude Code OAuth com o destino exato e incluir um adaptador OpenAI compatível. Inspecionar as ferramentas efetivamente enviadas. Medir tempo até o primeiro texto, tamanho de entrada e tokens em cache nas perguntas seguintes, por provedor, em conversas curtas e longas. |

## O que foi verificado nesta pesquisa

- **Armazenamento real.** Duas instâncias de `FsSessionStore` usaram uma sessão sintética em disco. A leitura deixou idênticos os hashes dos arquivos do principal. O escritor continuou, e o texto da mensagem 3 mudou ao concluir a resposta mantendo o mesmo `seq`. A cópia capturada preservou o texto anterior.
- **Adaptador real, provedor HTTP local.** Com a resposta principal intencionalmente pausada, o `OpenAIChatProvider` completou duas perguntas laterais. A segunda requisição continha a resposta da primeira. Uma terceira foi cancelada e o principal concluiu normalmente. A carga lateral enviada ao servidor continha zero ferramentas.
## Implementação na versão 3.16.65

O compositor encaminha `/side` e `/btw` para o painel antes do envio e da fila. A abertura captura a revisão do principal e resolve o provedor, o modelo e o esforço dessa sessão. Cada pergunta tem um ID idempotente. A resposta aparece progressivamente e o painel pode retomar a leitura pelo último caractere recebido. O cancelamento sinaliza apenas a chamada lateral.

O serviço grava o histórico e as revisões consultadas em `.side-chats/<id-do-principal>.json`, ao lado dos diretórios de sessão. O modelo recebe os resultados públicos de ferramentas concluídas e as respostas laterais anteriores. O adaptador precisa garantir inferência textual. No ChatGPT, a chamada usa um identificador de sessão próprio e desativa ferramentas hospedadas de imagem.

Para reproduzir o ensaio no Windows, execute `node scripts/release/side-chat-desktop-smoke.mjs dist/codestudio-3.16.65-completa`. Com `--live-chatgpt`, o teste usa a conexão ChatGPT configurada e um projeto sintético. O intermediário local segura o fim da resposta principal após o primeiro texto para permitir a comparação do diário, estado, fila e rascunho durante a execução. O relatório JSON é gravado ao lado do instalador.

### Resultado no Windows

- No executável 3.16.65, o ChatGPT respondeu com `gpt-6.2-sol` e esforço `low` nas duas conversas. O painel recuperou um código que só aparecia no principal e lembrou na segunda pergunta uma palavra que só aparecia na lateral. O cancelamento da terceira pergunta afetou apenas a chamada lateral. O principal completou uma única vez.
- Antes de liberar o fim da resposta principal, o ensaio comparou hashes do diário, estado e metadados, além da fila em IndexedDB, aprovações, mensagens de colaboração, rascunho e seleção. A sessão lateral usou um identificador próprio e enviou zero ferramentas. Após reiniciar o aplicativo, as duas respostas e o cancelamento continuaram visíveis. A seleção de um trecho e a atualização explícita de contexto também passaram.
- As respostas laterais começaram em 1,88 s e 1,81 s nessa execução. O ChatGPT informou 154 e 195 tokens de entrada, respectivamente, com zero tokens em cache nessas duas amostras.
- Em outra conversa sintética de 83 mensagens, a captura usou 35.970 dos 36.000 caracteres disponíveis. Uma seleção na primeira mensagem continuou acessível fora da janela recente, e o diário do principal conservou o mesmo SHA-256.
- A tipagem passou no servidor e no dashboard. As 27 suítes de regressão da branch passaram em 346 testes. Outras quatro suítes dos adaptadores Anthropic e OpenAI compatível passaram em 23 testes locais.
