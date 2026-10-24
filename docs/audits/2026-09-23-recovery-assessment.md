# Avaliação de recuperação do CodeStudio

Data: 23/09/2026. Workspace: `D:\MCP`. Branch: `feature/ide-mvp`. HEAD observado: `2d24020c` (18/08/2026).

## Conclusão

O código atual está em uma migração funcionalmente incompleta. A separação removeu os pontos de entrada e a composição do aplicativo anterior antes de preservar os contratos que a interface utiliza. Em paralelo, copiou interfaces para novos pacotes, introduziu novos bancos e substituiu o caminho público do agente por uma chamada simples ao modelo.

O usuário confirmou que **o CodeStudio instalado funciona e o código atual está quebrado**. A instalação serve como referência de comportamento, mas ainda não foi demonstrada sua correspondência exata com um commit. Não é correto declarar um commit anterior como totalmente saudável somente pelo histórico.

Recomendação: recuperar primeiro uma distribuição Desktop funcional, mantendo módulos internos e os recursos existentes. Adiar o corte para vários executáveis até existir paridade verificável. A recuperação precisa recompor contratos, não apenas restaurar comandos ou esconder erros TypeScript.

## 1. Escopo e evidência

- Histórico recente, alterações locais, comandos, configurações de compilação, composição Electron, backend de produto, runtime do Agent, contratos, migrações e verificadores de arquitetura.
- Build real do renderer CodeStudio em diretório temporário.
- Verificação TypeScript de produção sem emitir arquivos.
- 13 testes existentes em quatro arquivos: independência, inspeção de ASAR, CodeStudioService e AgentCore.
- Sondagem executável do CodeStudioService com SQLite descartável e cliente Agent controlado. Nenhum provedor real foi chamado.
- Leitura dos metadados de ASARs instalados e gerados, sem abrir, substituir ou reiniciar a instalação.
- Nenhum banco pessoal, migração de dados, instalação ou código de produto foi alterado nesta avaliação.

Snapshot inicial do Git: **111 arquivos rastreados modificados, 357 removidos e 3.794 arquivos não rastreados**. Esses números abrangem o checkout, inclusive trabalhos alheios à separação. Arquivos removidos podem ter sido realocados; os números não significam perda de dados.

A divisão em aplicações/serviços e os novos pacotes de UI estão principalmente nas alterações locais. A linha do tempo dos commits, sozinha, não mostra o estado que está falhando agora.

## 2. Achados prioritários

### P0 — O fluxo documentado de desenvolvimento deixou de existir

`README.md:37` e `docs/ELECTRON_DEV.md` orientam usar `pnpm electron:dev`. O manifesto atual removeu esse comando e também `dev`, `dev:server`, `dev:dashboard`, `start`, `start:server` e `start:api`. Os respectivos pontos de entrada do aplicativo anterior foram removidos.

`dev:codestudio` executa somente Vite. `apps/product-shell/renderer-fetch.ts` redireciona `/api` para `mcp://app`, protocolo registrado pelo Electron. Vite sozinho não substitui a inicialização do main, preload e backend.

O problema foi transformado em regra: `scripts/suite-independence.json` proíbe os comandos e entrypoints antigos. A recuperação terá de revisar essa decisão e seus testes; restaurar arquivos isoladamente deixará verificadores e implementação em desacordo.

### P0 — A compilação completa reprova, embora o renderer seja gerado

Comando executado: `node node_modules/typescript/bin/tsc -p tsconfig.prod.json --noEmit --pretty false --incremental false`. Resultado da execução com log integral: **exit 2, 330 diagnósticos**.

Distribuição: `codestudio-ui` 285, `my-apps-ui` 32, `sprite-ui` 11 e `documentation-ui` 2. São diagnósticos do estado atual, não 330 causas independentes: parte pode ser dívida antiga da UI que a nova composição passou a incluir no checker de produção.

Exemplos observados:

- `packages/codestudio-ui/src/legacy/apps/dashboard/components/AboutDialog.tsx:24`: `__APP_VERSION__` não declarado.
- `packages/codestudio-ui/src/legacy/apps/dashboard/components/ProjectSwitcher.tsx:128`: `windowRegistry` ausente em `ElectronAPI`.
- Fluxos de OAuth, janelas, streams e chamadas IPC encontram contratos Electron incompatíveis.
- Há imports/exports ausentes, conflitos de tipos das sessões e imports JSON incompatíveis com a configuração NodeNext nos novos pacotes de UI.

`tsconfig.json` exclui o dashboard original, mas inclui `packages/*/src/**/*.ts`. Os novos `index.ts` importam as interfaces copiadas; seus TSX entram no programa de produção. O build Vite transpila esse código e **passou**, o que não equivale à aprovação do TypeScript nem do aplicativo completo.

`scripts/build-product-electron.mjs` executa TypeScript antes do build normal. O uso de `--skip-tsc` pode gerar artefatos sem resolver esta falha.

### P0 — A interface conserva funcionalidades cujo backend foi retirado

`apps/codestudio-service/runtime.ts:67` implementa um subconjunto das operações. O default de RPC lança `codestudio method is unavailable`; rotas desconhecidas retornam 404 ou 501. Em `:193`, sessões recentes retornam uma lista vazia constante.

Resultados da sondagem com banco temporário:

| Operação | Resultado |
| --- | --- |
| `GET /api/projects`, Agent disponível | 200 |
| `POST /api/coder/sessions` | 404 |
| `GET /api/projects/1/snapshots` | 501 |
| `GET /api/projects/1/runners` | 501 |
| RPC `lsp.listServers` | método indisponível |
| RPC `terminal.spawn` | método indisponível |
| RPC `runner.events` | método indisponível |
| RPC `coder.sessions.list` | método indisponível |
| `GET /api/projects`, Agent indisponível | 400 |

As chamadas RPC acima foram testadas diretamente no owner. Na composição Electron, streams são enviados ao Agent, cujo `stream()` aceita apenas `agent.run`; portanto também falta a implementação correspondente dos streams do produto.

A própria `docs/architecture/modular-suite-matrix.md:40` registra como pendentes LSP, terminais/runners/debug, autocomplete, sessões/Company, snapshots/memória, operações avançadas de Git, banco/SSH/cliente de API e administração. Essa pendência coincide com o código e com as falhas reproduzidas.

### P0 — O novo Agent não preserva o agente de programação

Caminho ativo: `apps/agent-cli/index.ts` → `backend-gateway.ts` → `apps/agent-service/runtime.ts` (`AgentCore`).

Em `AgentCore.run`, linhas 143–165, a execução fornece uma única mensagem de usuário ao provedor e `tools: []`. Se o provedor emitir chamadas de ferramenta, lança `agent.run does not expose tools`.

Esse caminho não recompõe o loop de execução, ferramentas de arquivos/shell, MCP, subagentes, retomada e persistência do agente existente em `packages/code-agent`. O código anterior ainda existir no repositório não o torna alcançável pela nova aplicação.

O contrato novo `AgentRunInput` também não representa, por si só, todo o ciclo de sessão, permissões, projeto e ferramentas do agente anterior. A recuperação deve integrar o runtime completo por uma fachada que preserve esses contratos.

### P1 — A independência foi obtida em parte copiando a interface

Comparação de conteúdo com os arquivos correspondentes do dashboard:

| Pacote | Arquivos em `src/legacy` | Cópias idênticas ainda presentes no dashboard original |
| --- | ---: | ---: |
| `codestudio-ui` | 2.732 | 2.730 |
| `my-apps-ui` | 298 | 298 |
| `sprite-ui` | 203 | 203 |
| `documentation-ui` | 79 | 79 |

São **3.312 arquivos**, dos quais **3.310** têm uma cópia idêntica no caminho original. Os dois restantes são os entrypoints removidos do local antigo.

O build CodeStudio gerou chunks de `SpriteStudioView`, `AppStudioView`, `DocsPage`, administração e outras superfícies. O verificador de fronteiras aceita essas cópias porque estão dentro do diretório permitido `packages/codestudio-ui`. Isso não demonstra separação funcional ou eliminação das dependências de produto.

A médio prazo, uma correção pode atingir apenas uma cópia e deixar as demais divergentes. A solução é definir fontes únicas para UI e contratos, antes de mover ou distribuir produtos novamente.

### P1 — A abertura da IDE ficou acoplada à disponibilidade do Agent

`CodeStudioService` aguarda `syncProjectCatalog` até para listar projetos (`:71`, `:85`, `:121`). Na sondagem, a queda do Agent transformou uma consulta local válida em HTTP 400.

`packages/suite-client/src/autostart.ts` descobre ou executa `codestudio-agent`. A composição aguarda sua saúde, e `apps/product-shell/main.ts:276` guarda a promessa de inicialização. Uma rejeição fica armazenada para chamadas seguintes, pois não existe reset dessa promessa no caminho lido.

A IDE deve conseguir abrir, listar projetos e editar arquivos sem o Agent. A sincronização precisa ser recuperável; falha do serviço deve afetar as funções dependentes de IA, com erro e ação de recuperação visíveis.

### P1 — Dados e distribuição mudaram junto com a arquitetura

O layout novo usa `shared/agent.db` e bancos em `products/<produto>/`. Existe uma migração offline explícita em `scripts/sqlite-ownership-cutover.ts`, que pode aposentar a origem após validação. Sua existência não comprova que os dados de uma instalação real já foram migrados ou que todos os fluxos foram preservados.

As migrações de produto também usam snapshots de schema; por exemplo, `apps/codestudio-service/migrations/index.ts` retorna quando encontra a tabela de versão, sem demonstrar uma sequência de upgrades posteriores. Compatibilidade com instalações reais precisa ser um gate próprio.

ASARs observados com a **mesma versão 0.5.2**:

- Instalado em `C:\Program Files\CodeStudio`: main `dist/apps/electron/main.js`, 42.735 entradas; usuário confirma funcionamento.
- Artefato intermediário em `dist/installers/codestudio`: main modular, 1.888 entradas e renderer ainda em `dist/dashboard`.
- Artefato final em `dist/installers-final/codestudio`: main modular, 49 entradas e renderer no pacote novo.

Esses artefatos não são intercambiáveis. Versão, commit, estado local, contratos e build precisam ser identificados juntos. O problema de caminhos do artefato intermediário não deve ser atribuído ao instalado funcional nem ao final.

### P1 — Os gates atuais não provam recuperação do produto

- Independência da suíte: passou.
- 13 testes selecionados: passaram; verificam comportamento de gates e um subconjunto dos novos serviços.
- Renderer CodeStudio: passou.
- TypeScript de produção: reprovou.
- Fronteiras gerais, executadas com o Git reconhecendo corretamente o checkout: 12 novas violações frente ao baseline; 454 entradas antigas removíveis.
- O verificador geral usa `git ls-files`; boa parte da nova arquitetura não rastreada não entra nesse inventário. O scanner de independência tem outra estratégia e percorre o filesystem.
- Os documentos de migração registram a prova de janela Electron como bloqueada, não aprovada.

Durante a auditoria, o `pnpm` encontrado pelo ambiente era 11.19.0, enquanto o projeto declara 10.22.0. A tentativa do comando documentado acionou verificação automática de dependências e abortou antes de remover `node_modules`. Os demais checks usaram os executáveis locais diretamente. Essa diferença do ambiente da auditoria não foi tratada como causa comprovada da falha na máquina do usuário.

Evidências preservadas junto deste relatório:

- [Diagnósticos TypeScript](2026-09-23-recovery-evidence/typecheck-prod.log).
- [Sondagem do backend em banco descartável](2026-09-23-recovery-evidence/backend-probe.json).
- [Testes selecionados](2026-09-23-recovery-evidence/focused-tests.log).
- [Fronteiras gerais com Git corretamente configurado](2026-09-23-recovery-evidence/repository-boundaries.log).

## 3. Estratégia recomendada

### Etapa 0 — Fixar a referência e preservar o trabalho

1. Registrar o snapshot atual, incluindo arquivos não rastreados, sem reset nem limpeza global.
2. Registrar hashes/versão da instalação funcional e identificar o código correspondente por comparação dirigida; não presumir que todo o HEAD é a referência saudável.
3. Trabalhar a recuperação em checkout isolado que contenha o estado a recuperar e manter os dados de validação separados dos dados pessoais.
4. Congelar novas separações de executáveis, mudanças de schema e trocas de runtime durante a recuperação.

**Saída:** estado atual reproduzível e referência de comportamento identificada.

### Etapa 1 — Recuperar inicialização de ponta a ponta

1. Restaurar um único comando de desenvolvimento que inicie renderer, preload, Electron e backend coerentes.
2. Separar configurações TypeScript de frontend, main e serviços; definir a API do preload em um contrato único. Corrigir os erros reais, sem desabilitar o checker.
3. Recuperar a composição que suporta as operações da interface. Reutilizar handlers/runtime existentes; não recriar cada recurso com implementações reduzidas.
4. Fazer a janela aparecer com tratamento explícito de falhas de bootstrap, e permitir que o workspace básico funcione quando o Agent estiver indisponível.
5. Ajustar os gates que hoje proíbem o caminho necessário para recuperação.

**Gate:** em perfil descartável, o comando documentado abre a janela, lista/abre um projeto, lê, edita e salva um arquivo. O build completo passa, não apenas Vite.

### Etapa 2 — Recuperar o agente completo

1. Conectar a UI ao runtime de programação completo através de uma fachada compatível com sessões e ferramentas.
2. Preservar providers, configurações, permissões, arquivos/shell, MCP, subagentes, streaming, cancelamento e retomada.
3. Manter a escolha entre processo integrado, worker ou serviço externo como detalhe de implantação depois de validar o comportamento.

**Gate:** o usuário cria uma tarefa; o agente lê e altera um arquivo de fixture, executa um teste e apresenta o resultado; cancelamento funciona; reiniciar e reabrir conserva a sessão. Ferramentas são realmente executadas, não apenas mencionadas na resposta.

### Etapa 3 — Recuperar as ferramentas da IDE por fluxo

Ordem: terminal/runners → LSP/autocomplete/debug → Git e snapshots → memória/documentação → cliente de API, bancos e SSH → Sprite Studio e App Studio.

Para cada fluxo: inventariar chamadas da UI, mapear o handler real e executar um cenário ponta a ponta. Se um recurso faz parte do produto anterior, não marcar a recuperação como concluída deixando 404/501 ou listas vazias no seu lugar.

**Gate:** uma matriz de paridade sem operações essenciais ausentes e um teste de fluxo significativo por capacidade.

### Etapa 4 — Consolidar módulos e dados

1. Escolher uma única fonte para cada componente hoje duplicado.
2. Manter módulos por responsabilidade dentro de uma distribuição inicialmente integrada.
3. Validar migração de dados em cópias consistentes, com leitura e uso das funcionalidades, além de contagem/checksum.
4. Se a suíte de executáveis ainda for desejada, extrair um produto por vez com compatibilidade, instalação limpa, upgrade e rollback demonstrados.

**Gate:** nenhuma duplicação de implementação ativa entre produtos, nenhuma perda de dados e mesma funcionalidade antes e depois da extração.

## 4. O que evitar

- Resetar todo o checkout ou descartar milhares de arquivos não rastreados para tentar voltar a uma versão antiga.
- Retornar sucesso vazio, remover telas ou trocar o agente por um chat simples para fazer testes passarem.
- Desabilitar typecheck, aumentar baselines de arquitetura ou avaliar independência somente por nomes de diretórios.
- Aplicar a migração offline nos dados da instalação que está funcionando antes de validar a recuperação em uma cópia.
- Continuar extraindo cinco produtos simultaneamente durante a recomposição dos fluxos essenciais.

## 5. Limite da conclusão

Esta avaliação confirma falhas de compilação e de contratos no código atual, além da ausência do comando de desenvolvimento documentado. Não identifica uma exceção específica de uma janela Electron atual porque o usuário não forneceu o comando/log de abertura e nenhuma instalação foi reiniciada. O funcionamento do instalado foi confirmado pelo usuário; seus metadados foram verificados por leitura.

A primeira entrega de correção deve ser a Etapa 1, seguida imediatamente do fluxo mínimo do agente da Etapa 2. A separação em aplicações pode ser reconsiderada depois que esses gates passarem.
