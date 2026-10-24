## Context

A primeira fase criou cinco entrypoints, executáveis e instaladores, mas não concluiu a independência arquitetural. Os renderers de Sprite Studio, Meus Apps e Documentação ainda importam diretamente `apps/dashboard/features/*`; o CodeStudio ainda é construído a partir do dashboard monolítico; e o Agent chama `createApp()` de `apps/http-api/server.ts`, empacotando `http-api`, `mcp-server` e praticamente todos os packages. Assim, a separação atual é de distribuição/processo, enquanto frontend, backend, dependências e custo instalado continuam acoplados.

A suíte deve passar a ter bounded contexts reais e artefatos proporcionais. O Agent permanece a autoridade compartilhada de providers, credenciais, configuração global e execução de agentes. Cada produto passa a possuir seu frontend, seu composition root de backend, seu serviço local e seu banco físico, sem dois writers para o mesmo arquivo. Integração entre produtos ocorre apenas por contratos publicados e RPC local autenticado. Compatibilidade com `CODESTUDIO_DATA_DIR`, `MCP_DATA_DIR` e `~/.mcp-code-indexer` deve ser preservada; `CODESTUDIO_DATA_DIR` mantém precedência.

## Requirements

1. **Aplicações e fontes independentes**
   - Criar raízes publicáveis próprias para UI de CodeStudio, Sprite Studio, Meus Apps e Documentação.
   - Nenhum `apps/*-desktop` ou package de produto pode importar `apps/dashboard`, `apps/http-api`, rotas ou stores de outro produto.
   - `apps/dashboard` deixa de ser owner de features de produto; pode permanecer temporariamente apenas como shell legado durante a migração, devendo ser removido do caminho de build final.
   - Componentes visuais realmente genéricos devem ir para um package UI explícito e sem conhecimento de domínio; componentes de domínio permanecem no package do produto.

2. **Backends por bounded context**
   - Criar serviços/composition roots independentes para `codestudio`, `sprite-studio`, `my-apps` e `documentation`.
   - Cada serviço monta apenas seus handlers, jobs, stores e dependências.
   - O Agent não pode importar `apps/http-api/server.ts`, `createApp()`, rotas de produto, `apps/dashboard` ou um composition root agregador.
   - O antigo `apps/http-api/server.ts` deve ser decomposto e removido do runtime final; não é aceitável escondê-lo atrás de um novo nome.
   - Código compartilhado permitido deve ser extraído em packages com API pública estreita e sem dependência reversa em produtos.

3. **Agent Core**
   - O Agent é responsável por discovery, autenticação local, providers/modelos/OAuth, segredos globais, configuração compartilhada, lifecycle e execução de agentes.
   - Ferramentas de agente que precisam de dados de produto usam ports RPC explícitos; não importam stores ou services do produto.
   - `codestudio-agent run <prompt>` deve funcionar usando o provider gateway final; não pode permanecer como stub.
   - O pacote do Agent deve declarar allowlist de packages e falhar no build se incluir backends/UI de produto.

4. **Serviços locais e IPC**
   - Usar Named Pipe no Windows e Unix domain socket em macOS/Linux; nenhuma API local deve abrir TCP por padrão.
   - Cada serviço possui endereço, discovery, token local, versão de protocolo, health/status/stop e single-instance lock próprios.
   - O desktop inicia ou conecta ao serviço do próprio produto e ao Agent conforme necessário.
   - Documentação deve executar ingestão e jobs sem janela aberta; seu serviço tem lifecycle de background próprio.
   - Sprite Studio e Meus Apps não dependem do processo CodeStudio.

5. **Ownership físico dos dados**
   - Agent: `shared/agent.db` para providers, modelos, OAuth, configuração global e metadados de execução compartilhada.
   - CodeStudio: `products/codestudio/codestudio.db` para projetos, indexação, workspace, editor, git, API client e estado da IDE.
   - Sprite Studio: `products/sprite-studio/sprite.db` para projetos/assets/jobs de sprites.
   - Meus Apps: `products/my-apps/apps.db` para aplicações, blueprints, builds e metadados do produto.
   - Documentação: `products/documentation/docs.db` para coleções, fontes, chunks, pesquisa e jobs.
   - Sessões/transcripts de agente permanecem nos bundles filesystem sob `sessions/`, com o Agent como writer durante execução.
   - Nenhum arquivo SQLite pode ter writers de dois serviços. Leitura cruzada direta também é proibida; toda consulta cross-context ocorre por RPC.
   - Criar migração offline, reiniciável e verificável do `index.db` legado para os owners acima, com journal, checksums/counts, lock global, backup/rollback e cutover atômico. Não usar dual-write.

6. **Contratos e providers compartilhados**
   - Criar contratos versionados por serviço em package sem infraestrutura.
   - Produtos consultam providers/configuração e solicitam inferência ao Agent por RPC.
   - Mudanças de provider feitas por um produto devem ser observadas pelos demais sem acesso direto ao banco.
   - Compatibilidade de protocolo deve falhar de forma explícita quando versões não forem suportadas.

7. **Empacotamento proporcional**
   - Cada instalador inclui somente seu desktop, serviço/backend, renderer, contratos e dependências transitivas permitidas.
   - O Agent não inclui `http-api` monolítico, dashboard, backends de produto ou assets de produto.
   - Instalar somente Agent + Sprite não pode baixar ou instalar código de Docs, Meus Apps ou CodeStudio.
   - Atualização e rollback continuam independentes por componente; manifesto Ed25519 com `keyId`, HTTPS, SHA-256 e tamanho permanece obrigatório.

8. **Multiplataforma e compatibilidade**
   - Implementar resolução de launchers, IPC, instalação e paths para Windows, macOS e Linux.
   - Preservar `CODESTUDIO_DATA_DIR > MCP_DATA_DIR > ~/.mcp-code-indexer`.
   - Deep links e dados legados devem ser migrados ou encaminhados sem reintroduzir dependência no shell monolítico.

## Design

### Topologia de processos

```text
codestudio-agent        owns shared/agent.db + sessions during execution
codestudio-service      owns products/codestudio/codestudio.db
sprite-service          owns products/sprite-studio/sprite.db
my-apps-service         owns products/my-apps/apps.db
documentation-service   owns products/documentation/docs.db

CodeStudio.exe      -> codestudio-service + codestudio-agent
Sprite Studio.exe   -> sprite-service + codestudio-agent
Meus Apps.exe       -> my-apps-service + codestudio-agent
Documentação.exe    -> documentation-service + codestudio-agent
```

Cada desktop é somente shell/renderização e não abre SQLite. Serviços podem ser binários Node/Electron-run-as-Node inicialmente, desde que sejam processos e artefatos independentes; a implementação não deve acoplar o contrato a Electron.

### Packages alvo

- `packages/local-service-protocol`: framing, discovery, autenticação e lifecycle genéricos, sem domínio.
- `packages/agent-contracts` e `apps/agent-service`: Agent Core.
- `packages/codestudio-contracts`, `packages/codestudio-ui`, `apps/codestudio-service`.
- `packages/sprite-contracts`, `packages/sprite-ui`, `apps/sprite-service`.
- `packages/my-apps-contracts`, `packages/my-apps-ui`, `apps/my-apps-service`.
- `packages/documentation-contracts`, `packages/documentation-ui`, `apps/documentation-service`.
- `packages/product-ui-kit`: somente primitives visuais e bridges de plataforma; nenhum import de features.

Os nomes podem ser ajustados para convenções existentes, mas as fronteiras e ownership não podem ser colapsados.

### API e composição

Cada bounded context expõe handlers tipados, não rotas Hono compartilhadas. Adaptadores Hono podem existir apenas nos serviços que realmente precisam de HTTP externo. O IPC local usa envelopes versionados e streaming; desktop e Agent dependem dos contratos, nunca das implementações. Composition roots recebem ports explicitamente e não usam singletons globais para conectar produtos.

O Agent oferece ports de provider catalog, credential operations, model invocation, agent run/stream, session lifecycle e configuração global. Serviços de produto oferecem ao Agent capabilities específicas por RPC, registradas somente quando o produto está instalado e rodando.

### Migração incremental sem falso positivo

1. Introduzir protocolo/host genérico e testes de single owner.
2. Extrair Agent Core e fazer `run` funcionar sem `createApp()`.
3. Extrair um vertical slice completo por vez, na ordem Documentação, Sprite, Meus Apps, CodeStudio.
4. Para cada slice: mover UI para package próprio, extrair stores/migrations/handlers para serviço próprio, conectar ao Agent por contrato, alterar installer e ativar gate negativo.
5. Executar migrador offline do banco legado antes do cutover daquele produto; verificar e somente então trocar discovery/launcher.
6. Remover `apps/http-api/server.ts`, rotas agregadas e aliases legados após o último slice.

Não é permitido manter fallback silencioso para o backend monolítico. Um fallback temporário deve ser flag explícita de desenvolvimento, default off em artefatos, ter prazo dentro desta implementação e desaparecer antes da aceitação final.

## Acceptance Criteria

1. Busca estática retorna zero imports de `apps/dashboard` nos quatro desktops e packages de produto.
2. Busca estática retorna zero imports de `apps/http-api`, rotas de produto ou stores de produto no Agent Core.
3. `apps/http-api/server.ts` e seu `createApp()` não participam de nenhum build/entrypoint final; ao final são removidos ou ficam fora do workspace publicado sem callers.
4. O Agent inicia, lista/configura providers, executa `codestudio-agent run`, mantém sessões e encerra sem qualquer produto instalado.
5. Cada produto inicia e realiza sua função principal com somente ele + Agent instalados.
6. Documentação indexa e pesquisa em background sem janela; Sprite gera/persiste um asset; Meus Apps cria e recupera uma aplicação; CodeStudio abre/indexa um projeto — cada um no próprio serviço/banco.
7. Dois produtos veem a mesma mudança de provider via Agent RPC, enquanto inspeção de handles/processos comprova um único writer para `shared/agent.db`.
8. Inspeção de bancos comprova que cada serviço abre somente seu DB e que nenhuma tabela de outro bounded context existe nele.
9. Migração de fixture legado produz os cinco destinos com counts/checksums aprovados, remove o lock após sucesso e restaura backup após falha injetada; nenhum dual-write é observado.
10. Inspeção de ASAR/artefato usa allowlists e falha se:
    - Agent contiver dashboard, http-api monolítico ou backend/UI de produto;
    - CodeStudio contiver Sprite, Meus Apps ou Docs;
    - qualquer produto contiver backend/store de outro produto.
11. Matriz de instalação seletiva comprova que `agent+sprite`, `agent+docs`, `agent+my-apps` e `agent+codestudio` funcionam isoladamente.
12. Builds e smokes passam no Windows, macOS e Linux, incluindo launcher, IPC e paths.
13. Manifesto assinado seleciona somente dependências requeridas, hashes/tamanhos conferem e rollback por componente preserva compatibilidade de protocolo/dados.
14. Gates de CI de imports, cycles novos, ownership de migrations, composição e artefatos são obrigatórios e não aceitam baselines que escondam novos acoplamentos.
15. Não há stubs nas jornadas aceitas, incluindo `codestudio-agent run`.

## Implementation Plan

1. Criar testes de arquitetura inicialmente vermelhos para imports, composição, ownership de migrations e conteúdo de artefatos.
2. Extrair `local-service-protocol` do lifecycle atual do Agent e generalizar discovery/locks/endpoints por service id.
3. Definir contratos versionados do Agent e dos quatro produtos; criar clients/hosts sem dependências de implementação.
4. Extrair provider/config/credential/model invocation e agent execution para `apps/agent-service`; implementar `codestudio-agent run`; remover dependência em `createApp()` e reduzir allowlist do Agent.
5. Implementar migrador offline do `index.db` com plano de disposição de tabelas, journal, verificação e rollback.
6. Extrair Documentação end-to-end: UI, backend, DB, jobs headless, installer e gates.
7. Extrair Sprite Studio end-to-end: UI, backend, DB, jobs e installer.
8. Extrair Meus Apps end-to-end: UI, backend, DB, agent ports e installer.
9. Extrair CodeStudio end-to-end: UI restante, project/index/workspace backend, DB e installer.
10. Remover aliases/imports de `apps/dashboard`, desmontar `apps/http-api/server.ts`, eliminar fallbacks e singletons cross-context.
11. Atualizar bootstrapper/manifesta para serviços proporcionais e migração/rollback por componente.
12. Executar typecheck, testes unitários/integração, fixtures de migração, smokes de processo/DB, inspeção de ASAR e matriz multiplataforma; documentar somente limitações externas reais, sem declarar conclusão parcial como conclusão arquitetural.