# Recuperação da base integrada — 24/09/2026

O código de `D:\MCP` voltou à base integrada do commit `2d24020c28785bf181c178c72b9eaea8c1bfcdea`, de 18/08/2026, na branch `codex/recovery-integrated-desktop`. A separação em aplicativos e serviços locais estava nas alterações não commitadas. A branch anterior, `feature/ide-mvp`, e seu histórico foram preservados. Não foi criado commit nem feito push.

Foram restaurados o Desktop Electron, o dashboard, o backend integrado, os contratos completos e os comandos anteriores. Foram arquivados 3.791 arquivos novos e 25 pastas residuais da separação, incluindo arquivos ignorados pelo Git. Os artefatos anteriores de `dist` também foram arquivados.

## Ajustes necessários na base recuperada

- Primeiro uso: o bootstrap não cria mais um cabeçalho SQLite antes da inicialização do schema; o pool de agentes lê suas configurações depois das migrações. A conexão temporária de configurações fecha mesmo em caso de erro.
- Streams: preservada a correção local que transfere `next`/`return` pelo `contextBridge` e reconstrói o iterador na interface. O teste real reproduziu a perda de `Symbol.asyncIterator` sem essa correção.
- SQLite nativo: a dependência local `better-sqlite3` 12.11.1 foi alinhada ao ABI 146 do Electron 42.5.0 com o binário da mesma versão da instalação funcional. O binário anterior, ABI 127 do Node, foi guardado no backup. A instalação foi apenas lida.

## Evidências

| Verificação | Resultado |
| --- | --- |
| TypeScript de produção, emissão, aliases e cópia de prompts em `D:\MCP` | passou |
| Build Vite da interface integrada | passou |
| Testes focados de inicialização, arquivos e terminal | 53 passaram |
| Testes de sessões e proteção do layout de persistência | 19 passaram |
| Testes do adaptador de streams | 3 passaram; repetidos no diretório restaurado |
| Electron real com perfil vazio e banco descartável | abriu a tela de entrada, sem erro de bootstrap |
| IPC/protocolo do aplicativo | projetos responderam HTTP 200; sessão criada e listada; arquivo lido, alterado e relido; snapshot de runner recebido |
| Terminal padrão real | executou `echo RECOVERY_TERMINAL_42` e recebeu a saída pelo stream |
| Reinício do perfil de teste | recuperou a sessão anterior e o conteúdo salvo |
| `.env` | conteúdo idêntico ao backup por SHA-256 |

Os testes finais usaram os padrões de banco por projeto habilitados, como no Desktop. Os testes do terminal usaram o shell padrão e responderam às consultas de terminal normalmente atendidas pelo xterm. A janela ficou oculta e foi capturada para conferência visual.

Evidências em [2026-09-24-recovery-evidence](./2026-09-24-recovery-evidence/). Os bancos e projetos de teste ficam somente em `.tmp/recovery-2026-09-24/`.

O login externo e uma conversa completa com provedor de IA real não foram exercitados. Não foi gerado instalador nem substituída a aplicação instalada. Os testes cobrem a abertura e os fluxos locais descritos acima, não uma certificação de todos os recursos.

## Como iniciar

No diretório `D:\MCP`, com as dependências já presentes:

```powershell
npm run electron:dev
```

O script restaurado inicia Vite e Electron juntos. Para alternar futuramente para testes que usam SQLite no Node, será necessário `pnpm node:rebuild`; antes de voltar ao Desktop, `pnpm electron:rebuild`, conforme o fluxo existente do projeto.

## Backup e recuperação do estado anterior

Backup local: `D:\MCP\.tmp\recovery-2026-09-24`.

- `snapshot/`, `manifest.json` e `snapshot-complete.json`: 11.616 arquivos copiados e verificados, incluindo `.env`; o manifesto também registra os 357 caminhos que estavam apagados.
- `metadata.json`, `working-tree.patch` e `index.patch`: branch, HEAD e diferenças anteriores.
- `quarantine/`: arquivos novos retirados da árvore de trabalho.
- `residual-modular-folders/`: pastas restantes das aplicações/pacotes novos, incluindo conteúdo ignorado pelo Git.
- `generated-dist-before-recovery/`: builds e instaladores anteriores.
- `better-sqlite3-node127.node` e `native-runtime.json`: biblioteca nativa anterior e registro da substituição local.
- `restore-complete.json`: base e arquivos reaplicados na recuperação.

Para recuperar a tentativa de separação, use esse conjunto em uma cópia separada e confira o manifesto; trocar de branch sozinho não recupera alterações que nunca foram commitadas. O backup contém configuração local e deve permanecer privado. Dados pessoais, instalação em uso e o repositório independente da extensão Unity foram preservados.
