# Chat, visão sob demanda e revisão da suíte

## Comportamento entregue

- O chat usa apenas um controlador de acompanhamento. Rolar para cima libera o scroll antes do próximo frame; novos tokens não o prendem novamente. O acompanhamento retorna ao chegar ao fim por movimento descendente, ao clicar no botão de últimas mensagens ou ao trocar de sessão.
- Menos padding entre mensagens, textos e ferramentas. A barra de ações da mensagem não reserva espaço quando oculta.
- Galeria com miniaturas sem corte, visualizador fora das linhas virtualizadas, navegação por teclado e tamanho original. Imagens já carregadas não fazem outra requisição de miniatura; imagens persistidas são buscadas individualmente.
- Removido o teto de quatro anexos. A quantidade não tem limite fixo; permanecem os limites de recursos: 10 MB por arquivo e 25 MB por envio, além dos limites existentes de texto.
- O histórico durável preserva as imagens. O contexto enviado ao provider usa referências; `view_image` envia somente os pixels selecionados para a inferência seguinte. O agente pode reabrir imagens por ID, listar as imagens da sessão após reinício/compactação e abrir qualquer caminho de imagem autorizado no projeto ou nas raízes permitidas.
- `view_image` aceita recorte e resolução de preview. A imagem original continua disponível. Capturas produzidas pelas ferramentas entram pelo mesmo fluxo de blocos de imagem.
- `view_video` extrai até oito timestamps por chamada, localmente, com FFmpeg. Os frames podem ser reconsultados como imagens. Não inclui transcrição de áudio.
- A ferramenta hospedada de geração do Codex passa a solicitar `gpt-image-2.5-sunburst`. Mantido o opt-in existente `CODEX_IMAGE_GEN_ENABLED=1`; disponibilidade real depende da conta/rota. Não foi realizada uma geração paga nesta validação.

## Decisões e limites

`projectVisionContext` projeta uma cópia do histórico, sem remover pixels da conversa salva. O catálogo e os payloads usam o bundle da própria sessão, com IDs por conteúdo; `drain()` integra a persistência à barreira existente. Não há TTL global que invalide imagens antigas. Hosts que não oferecem o armazenamento durável conservam o comportamento anterior.

O acesso por caminho reutiliza a autorização de leitura do workspace. O catálogo não aceita IDs de outra sessão. Previews são normalizados com Sharp, com orçamento de bytes/pixels, antes de chegar ao provider. A listagem retorna 50 referências por página e nenhum pixel.

FFmpeg e os binários do Sharp são dependências do pacote desktop, descompactadas do ASAR. O preflight de build verifica a presença do executável; o smoke do pacote abre uma imagem e extrai um frame usando os arquivos efetivamente distribuídos.

## Revisão dos testes

Foram removidos três casos de worktree que só repetiam a falha de diretório inválido, sem provar o comportamento descrito pelo título. Os testes de criação, isolamento, remoção e preservação de alterações em um Git real foram mantidos.

Dois casos sobrepostos do predicado de scroll foram consolidados, preservando suas verificações de borda. Dois specs antigos de captura de baseline foram removidos; permanecem os testes visuais e de comportamento do workbench. As sete verificações de tradução foram mantidas, reutilizando a leitura e a árvore sintática de cada arquivo.

`pnpm test` e `pnpm test:quick` agora executam a seleção explícita de fluxos críticos de `scripts/test-critical-paths.mjs`: runner, permissões, sessões e persistência, providers, anexos, chat e visão. Também executam os oito arquivos que exigem Node real e os três checks de scripts de build. `pnpm test:workspace` mantém a execução exaustiva. Não confundir a seleção rápida com a suíte inteira.

## Evidência desta alteração

- Suíte rápida: 88 arquivos / 739 testes em Electron, 8 arquivos / 85 testes em Node, 3 checks de build; todos passaram. Etapa Electron em 130,99 s, Node em 11,55 s e scripts em 2,09 s nesta máquina.
- Integrações adicionais de prompt, tiers e code_exec: 12 arquivos / 114 testes passaram.
- Traduções: 7 testes passaram, em 14,45 s no total.
- Navegador: 6 cenários passaram em 1280×720, 1440×900 e 1920×1080. Usam os componentes reais com mensagens simuladas e API isolada; conferem stream durante leitura, retomada, seleção/conversão de 15 arquivos, pixels da galeria e navegação por teclado.
- Verificações de tipos, limite de linhas, ciclos, dependências entre pacotes e código morto passam. O gate de boundaries usa o baseline existente: isso não significa ausência de dívida arquitetural histórica.
- Relatórios locais: `.tmp/critical-tests.log`, `.tmp/vision-tool-integration.log`, `.tmp/chat-browser-final.log`; imagens de revisão: `.tmp/chat-compact-final.png` e `.tmp/chat-gallery-final.png`.
- Pacote Windows: `dist/electron-vision-20261024/CodeStudio Setup 3.15.1.exe` (340.946.891 bytes), SHA-256 `c160e6c9c92bdbaa16deec1fd07a16c048f5c4893126947e1de5c4e605bd7391`. Build de desenvolvimento sem assinatura.
- Smoke do pacote: 2.417 módulos e 42 dependências alcançáveis sem ausência; renderer, deep link, indexador, QuickJS, conversão web e visão de imagem/vídeo passaram. Abertura real do executável em perfil isolado com IPC de projetos funcionando, zero erros de console e nenhum processo do probe remanescente. O aplicativo instalado do usuário não foi substituído.
- Auditoria do pacote: zero caminhos do runtime Rust retirado, tanto no ASAR quanto nos arquivos externos. Gramáticas/ícones da linguagem Rust permanecem como suporte normal do editor.

Para repetir o navegador, inicie `pnpm dev:dashboard` e rode `pnpm test:visual chat-stream.spec.ts` com `CODESTUDIO_E2E_URL` apontando para o Vite. O fixture está em `apps/dashboard/e2e/fixtures/chat-stream.html` e não é uma entrada do bundle de produção.

## Referências consultadas

- [Codex prompting guide: view_image](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
- [OpenAI: imagens e visão](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI: ferramenta de geração de imagens](https://developers.openai.com/api/docs/guides/tools-image-generation)
- [OpenAI: gpt-image-2.5-sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [Claude Code: ferramentas, incluindo Read para imagens](https://code.claude.com/docs/en/tools-reference)
- [Anthropic: práticas de prompting, vídeo por frames](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
