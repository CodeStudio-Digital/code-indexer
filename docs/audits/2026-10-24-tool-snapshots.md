# Snapshots das edições no chat

## Correção

Os cartões de ferramentas consultavam a baseline acumulada da sessão. Uma edição posterior no mesmo arquivo alterava os números e o diff exibidos nos cartões anteriores.

Cada chamada agora registra seu próprio antes/depois, identificado pelo `tool_use_id`, dentro do bundle da sessão. O registro ocorre após a mutação bem-sucedida. Múltiplas escritas da mesma chamada são consolidadas; chamadas diferentes permanecem separadas. O contexto assíncrono mantém a atribuição correta em chamadas concorrentes e aninhadas.

Os cartões consultam esses registros para os totais, conteúdo e números de linha. Não consultam o arquivo atual nem usam a baseline global como fallback. O diff histórico é de leitura; as ações de revisão e reversão continuam no resumo e na modal existentes. Renomeações registram origem e destino; criação e exclusão preservam a existência antes/depois.

O resumo final continua agregado por rodada, e a modal continua acumulada por sessão. As rotas também atendem o escopo Company, limitado às sessões filhas vinculadas; IDs de chamada ambíguos entre filhos não são adivinhados.

## Persistência e custo

Os conteúdos usam os blobs por hash já existentes. A recuperação de artefatos reconhece as referências dos novos registros para não apagar estados intermediários ainda usados pelo histórico. A leitura compartilha varreduras concorrentes e mantém um cache limitado de UUIDs, sem guardar todos os conteúdos dos arquivos na memória.

Cartões antigos sem captura por chamada mostram indisponibilidade, em vez de apresentar o acumulado como se fosse daquela edição. Não é possível recuperar com exatidão um estado intermediário que a versão anterior não salvou. Arquivos binários/grandes mantêm o tratamento de diff desabilitado.

## Validação

- Integração com registro real de ferramentas, filesystem e bundle: duas edições do mesmo arquivo, nova rodada, alteração externa, reabertura com recuperação de artefatos, concorrência, várias escritas por chamada, renomeação, exclusão e falha de escrita.
- Rotas: totais e números de linha da chamada, índices inválidos e isolamento de sessões/Company.
- Navegador com componentes reais e API isolada: cartões `+2/−1` e `+1/−0`; resumo e modal `+3/−1`; stream, edição posterior e recarregamento. Passou em 1280×720, 1440×900 e 1920×1080.
- Dois testes antigos expuseram prazos frágeis sob carga. O teste de shell agora permite a inicialização real do interpretador e verifica o encerramento por condição. O teste de vídeo limita a criação do fixture, usa uma thread de encoder, aborta/fecha recursos no teardown e tem prazo total compatível com as três extrações limitadas individualmente a 20 s. Nenhuma asserção funcional foi retirada.
- Suíte rápida final: 89 arquivos / 741 testes em Electron, 8 arquivos / 85 testes em Node e 3 verificações de scripts de build; tudo passou. A etapa Electron levou 147,74 s e a etapa Node 13,29 s nesta execução. A cobertura nova de persistência foi adicionada à seleção rápida.
- As 50 verificações direcionadas de snapshots, rotas, registry e mutation fence passaram após corrigir as expectativas dos novos testes. Há sobreposição com a suíte rápida.
- Typecheck do backend/dashboard, build de produção e Knip passaram. Limite de linhas: zero violações graves; ciclos: nenhum; boundaries: nenhuma regressão contra o baseline existente. O gate de boundaries não implica ausência de dívida histórica.

Relatórios locais: `.tmp/snapshots-quick-final.log`, `.tmp/tool-snapshots-results.json`, `.tmp/snapshots-installer-build.log`. A captura de navegador está em `.tmp/tool-snapshots.png`.

## Pacote Windows

`dist/electron-snapshots-20261024/CodeStudio Setup 3.15.1.exe`, 340.948.800 bytes. SHA-256: `1543d21d22b4126e949176f0f43a25b7ba423b35cf247dca4f3acd694d9f9134`. Build de desenvolvimento sem assinatura; o aplicativo instalado do usuário não foi substituído.

Integridade do instalador passou. O smoke validou 2.421 módulos alcançáveis e 42 pacotes sem dependências ausentes, renderer, deep link, indexador, QuickJS, conversão web e visão de imagem/vídeo. O executável abriu em perfil isolado, o IPC respondeu e a nova rota de snapshots foi alcançada pelo renderer. Nenhum erro de console ou processo do probe remanescente. A auditoria não encontrou o runtime Rust removido.

As alterações simultâneas de worktrees em outros arquivos do checkout não fazem parte desta correção nem deste relatório.
