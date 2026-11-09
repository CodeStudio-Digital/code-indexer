# CodeStudio 3.15.11 — conexões MCP

Correção da autenticação concluída que deixava o painel parado sem ferramentas disponíveis. Escopo: conexões HTTP, SSE e stdio, OAuth, catálogo compartilhado, formulário e ciclo de vida da interface.

O defeito do Hostinger foi reproduzido com a configuração local: o cliente usado no teste antigo não recebia o resolvedor OAuth. Com o token já salvo, o mesmo servidor respondeu e listou três ferramentas. O código da janela também confundia tokens recebidos com conexão MCP concluída e não atualizava o catálogo utilizado pelo agente.

| Problema confirmado | Correção |
| --- | --- |
| OAuth mostrava sucesso antes de inicializar MCP e listar ferramentas | Separação entre autorização e conexão; a janela conclui depois do teste real e atualiza o painel. |
| Teste e enumeração ignoravam tokens OAuth salvos | Injeção do mesmo resolvedor usado pelo runtime. |
| Catálogo do agente ficava desatualizado depois da autenticação | Teste de servidor habilitado conecta diretamente ao pool e publica suas ferramentas. |
| Reconectar um servidor encerrava os demais | Reconciliação isolada, preservando conexões e revisões das ferramentas de outros servidores. |
| Falha em `tools/list` podia virar sucesso com zero ferramentas | Verificação do estado após enumeração; erros são apresentados ao usuário. |
| Token ficava congelado nos headers do transporte | Resolução em cada requisição HTTP/SSE, incluindo reconexões. |
| Renovação concorrente usava o mesmo refresh token várias vezes | Uma renovação em andamento por servidor, compartilhada entre os consumidores. |
| Timeout, falha de rede, 429 e 5xx apagavam credenciais | Preservação dos tokens em falhas transitórias; descarte somente diante de `invalid_grant` correspondente. |
| Resposta atrasada de renovação podia restaurar credenciais após desconectar | Verificação do token e do registro atual antes de persistir. |
| Um bearer rejeitado continuava sendo reutilizado | Invalidação para a próxima requisição; chamadas de ferramentas não são repetidas automaticamente. |
| Falha de autenticação antes do envio virava resultado desconhecido da ferramenta | Erro anterior ao envio é identificado como tal, evitando bloquear o chat por uma operação que não saiu do processo. |
| Consentimento era identificado por relógio local e data de renovação | Acompanhamento da tentativa OAuth exata, com estado, erro, expiração e cancelamento. |
| Popup podia sinalizar sucesso sem confirmação do backend | A conclusão é consultada no backend; mensagens arbitrárias do navegador não concluem o fluxo. |
| Registro manual recebia metadados em formato incompatível | Serialização e leitura explícitas dos campos OAuth; preservação dos escopos anunciados. |
| Descoberta incompleta e requisições sem prazo | Fallback OpenID Connect e `WWW-Authenticate`, validação do issuer e timeouts. |
| Ausência de `resource` e suporte incompleto a clientes confidenciais | Persistência aditiva do resource, envio em autorização/tokens e suporte a `client_secret_basic`. |
| Falha ao abrir navegador mantinha a janela esperando | IPC com resultado/erro aguardável e mensagem imediata na interface. |
| Edição de argumentos stdio quebrava caminhos e textos com espaços | Array JSON de argumentos e edição de variáveis de ambiente sem descartar texto parcial. |
| Indicador de teste permanecia verde depois de editar ou desconectar | Invalidação do resultado anterior. |
| Inicialização do shadcn era interrompida após dez segundos | Prazo de conexão de 30 segundos, cancelável; prazo da interface inclui conexão, catálogo e limpeza. |

A partida real do shadcn levou 10.960 ms no diagnóstico com o SDK. As duas tentativas anteriores pelo manager encerraram com `External MCP connection deadline elapsed`. Um teste de regressão com inicialização de 11 segundos passou depois da correção.

O envio de `resource` e de autorização em cada requisição segue os requisitos descritos na [especificação MCP de autorização](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). O endpoint remoto e o fluxo OAuth do Hostinger estão documentados pelo [próprio fornecedor](https://www.hostinger.com/support/11079316-hostinger-api-mcp-server/). O comando de inicialização usado no teste de shadcn corresponde à [configuração oficial](https://ui.shadcn.com/docs/mcp).

Validação automatizada: **1.078 casos aprovados**, consolidando as execuções sem contar repetições. A execução ampla teve 1.066 casos; duas falhas iniciais de fixtures ocorreram porque seu diretório temporário estava dentro do repositório. As duas suítes completas passaram ao usar um temporário do sistema fora do projeto. Os testes posteriores cobriram as alterações finais e a partida lenta. Os resultados estão em [validation-summary.json](D:/MCP/.tmp/mcp-connections-2026-11-04/validation-summary.json).

Os testes de integração usam HTTP real, SDK MCP, SQLite e o pool, cobrindo OAuth, SSE, HTTP, catálogo paginado, renovação, `invalid_grant`, falhas transitórias, callbacks incorretos, cancelamento, registro manual, isolamento de conexões e ausência de repetição de efeitos. O teste empacotado de stdio cobre também execução de scripts, SQLite filho, cancelamento, paginação da saída e encerramento.

A verificação visual executa o aplicativo empacotado em um perfil isolado. A abertura do navegador é substituída somente por uma requisição a um servidor OAuth local; o callback loopback, IPC, troca de tokens, persistência e MCP são reais. São verificados erro de catálogo, tentativa com autorização salva, fechamento automático, falha do navegador, cancelamento, edição stdio e desconexão.

As consultas ao Hostinger e aos MCPs cadastrados restringem-se a inicialização e enumeração, sem executar suas ferramentas. O teste de shadcn/REA foi autorizado explicitamente pelo usuário após a revisão automática exigir autorização para executar comandos de terceiros. Os processos do teste são identificados por PID e data de criação.

O pacote preserva as correções anteriores do harness. Não foi instalado sobre a instância em uso e não houve commit, push ou publicação. A migração 274 adiciona metadados OAuth e preserva registros e tokens existentes. A compatibilidade com contas e operações de todos os provedores possíveis não é inferida dos testes de transporte.

As verificações de tipos do backend e do dashboard passaram. A checagem de hooks percorreu 1.454 arquivos e terminou sem diagnósticos novos; há 477 diagnósticos legados explicitamente registrados no baseline, sem novas exceções. Isso valida a ausência de regressões neste escopo, não a eliminação de toda a dívida React do produto. O encerramento do diálogo invalida operações de um ciclo anterior e impede atualizações tardias após desmontagem.

As conexões reais do pacote definitivo 3.15.11 passaram em 04/11/2026, às 21h39–21h40 (America/Sao_Paulo):

| Servidor cadastrado | Transporte | Ferramentas enumeradas | Tempo observado |
| --- | --- | ---: | ---: |
| Hostinger | Streamable HTTP + OAuth | 3 | 1.786 ms |
| Unity | Streamable HTTP local autenticado | 332 | 131 ms |
| shadcn | stdio | 7 | 18.022 ms |
| REA | stdio | 207 | 4.834 ms |

O resultado do Hostinger foi confirmado pela rota administrativa e pelo catálogo compartilhado usado pelo agente. Essas medições incluem inicialização e enumeração, não são médias de desempenho. Nenhuma ferramenta dos quatro provedores foi executada, e o perfil real foi aberto somente para leitura. A verificação confirmou zero processos restantes do teste local. Evidências: [Hostinger](D:/MCP/.tmp/mcp-connections-2026-11-04/hostinger-final-latest.json), [Unity](D:/MCP/.tmp/mcp-connections-2026-11-04/unity-final.json) e [shadcn/REA](D:/MCP/.tmp/mcp-connections-2026-11-04/configured-final.json).

O executável definitivo passou nos seis cenários de interface, sem erros de página, console ou requisições e sem processos restantes após o encerramento. O [relatório da interface](D:/MCP/.tmp/mcp-connections-2026-11-04/runs/2026-11-05T00-39-54-089Z/report.json) registra o hash do pacote executado. A [captura após conectar](D:/MCP/.tmp/mcp-connections-2026-11-04/runs/2026-11-05T00-39-54-089Z/connected-tools.png) mostra os diálogos fechados e a ferramenta do servidor de teste disponível no painel.

A validação nativa confirmou 2.463 módulos alcançáveis em 43 pacotes, sem módulos ausentes; renderização, deep links, tree-sitter, QuickJS, conversão HTML, Sharp/FFmpeg, stdio, SQLite, cancelamento, paginação de saída e leitura Git passaram. O [manifesto da validação](D:/MCP/.tmp/mcp-connections-2026-11-04/candidate-validation-zpjwLT/manifest.json) confirma que o artefato não mudou durante os testes. A checagem final de diferenças passou sem erros de espaços em branco.

Entrega: [CodeStudio Setup 3.15.11.exe](<D:/MCP/dist/electron-mcp-fix-20261104-final/CodeStudio Setup 3.15.11.exe>), instalador Windows x64, 340.971.996 bytes. Pacote local sem assinatura Authenticode (`NotSigned`). Os dados também estão em [release-final.json](D:/MCP/.tmp/mcp-connections-2026-11-04/release-final.json).

```text
SHA256 instalador: E3724F5D29BAE370D1B3AA4353D625947C5C23DFC03619628A501F7B35734564
SHA256 app.asar:   0A830AE26BB34E0158BF379A9E0FB945F9BB0C74758885C30D6653528882061B
```

Este é o instalador definitivo desta correção; os diretórios de candidatos anteriores são apenas evidências intermediárias. Para aplicar, encerre a instância instalada e execute o instalador acima. Credenciais e configurações existentes são preservadas; uma autorização já salva pode concluir a conexão pelo painel sem novo cadastro do MCP.
