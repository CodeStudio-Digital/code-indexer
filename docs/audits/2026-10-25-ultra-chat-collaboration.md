# Ultra e colaboração entre chats

Implementação na branch `codex/remove-rust-runtime`, sobre `2ee9646c`. O pacote usa uma exportação dos arquivos desta entrega em `.tmp/ultra-release`; alterações paralelas de App Studio, worktrees, anexos e rede de sessões permanecem no checkout compartilhado.

## Comportamento

- Ultra coordena investigação, implementação, revisão e validação, sem substituir o esforço de raciocínio escolhido nem forçar thinking ou compactação no nível máximo. `/ultra` e `/ultracode` ativam o modo naquele turno; menções comuns não ativam o modo.
- Chats explicitamente vinculados e agentes da mesma tarefa usam uma caixa de mensagens persistente fora do writer exclusivo da conversa. Há perguntas, tarefas, notificações, respostas correlacionadas, referências, cancelamento, expiração e deduplicação por chamada.
- Mensagens são identificadas como entrada de agente. A retomada passa pela admissão durável do host e mantém o modo, ferramentas e permissões do destinatário. Não interrompe uma execução ativa nem ultrapassa uma aprovação pendente. Notificações não iniciam inferência.
- Esperas usam eventos de filesystem e recusam dependências circulares. A recuperação verifica toda a fila pendente; histórico recente de outros chats não esconde pedidos antigos. Há limites de mensagens e de retomadas automáticas.
- Cada filho tem endereço próprio, inclusive dentro do mesmo grupo de spawn. `resume_chat` conserva o contexto e recusa checkpoints com efeito incerto.
- Ultra limita a concorrência a três filhos (ou ao limite menor do host), a oito ondas por workflow e a 24 admissões por execução com o limite padrão. Reutiliza o executor existente de spawn/workflow/execute_tasks.
- Implementadores Ultra em repositórios Git recebem checkouts isolados que incluem alterações não commitadas. Ferramentas nativas de arquivo ficam confinadas ao checkout. Comandos de shell, testes e mutações externas ficam com o coordenador.
- `read_chat_changes` apresenta a revisão; `integrate_chat_changes` verifica a versão original de cada arquivo, usa as portas com snapshots e exclusão entre processos, e reverte gravações em caso de falha. Um resultado já aplicado é reconciliado sem duplicação. Efeitos incertos exigem inspeção antes de retomar; não são reexecutados cegamente.
- O painel lateral permite vincular chats, inspecionar mensagens e pausar/retomar pedidos automáticos. O seletor de raciocínio continua disponível com Ultra ligado.

## Verificação

Os testes de comunicação executam dois CoderRunners reais com providers roteirizados: pergunta, resposta, espera e continuação com contexto. Os testes de isolamento usam um repositório Git real, alterações prévias, integração repetida, conflito, bloqueio entre executores e rollback após falha de gravação. Isso comprova os contratos e efeitos do runtime; não é uma avaliação de qualidade de respostas de modelos comerciais.

Foram corrigidas duas expectativas de `stream-idempotency.test.ts` que haviam antecipado a retirada de App Studio no commit anterior, embora a implementação correspondente ainda estivesse em outro trabalho. Os contratos de envio, continuação e writer foram preservados. A sincronização do teste entre runners passou a aguardar um evento explícito, com encerramento dos runners antes da limpeza; o teste Git possui prazo próprio para operações reais no Windows.

Relatórios locais:

- `.tmp/ultra-final-gate.log`: regressão crítica do Electron.
- `.tmp/ultra-release-quick-final.log`: testes de processos em Node e scripts de build.
- `.tmp/ultra-final-focused.log` e `.tmp/ultra-final-integration.log`: workflows, limites, idempotência e colaboração.
- `.tmp/ultra-release-types-final.log` e `.tmp/ultra-release-dashboard-types.log`: TypeScript.
- `.tmp/ultra-release-loc.log`, `.tmp/ultra-release-cycles.log` e `.tmp/ultra-release-boundaries.log`: arquitetura. Nenhuma violação grave de linhas, nenhum ciclo e nenhuma nova violação de fronteira. Avisos e baseline anteriores continuam registrados.
- `.tmp/ultra-ui.log` e `.tmp/ultra-collaboration.png`: interface real no navegador com dados controlados; vínculo, mensagens, pausa, retomada e escolha de raciocínio.

## Distribuição

O instalador é gerado em `dist/electron-ultra-20261025/CodeStudio Setup 3.15.1.exe`. Build de desenvolvimento sem assinatura. A instalação existente não é substituída durante a validação; o teste do executável usa perfil e dados isolados.

Resultado final: 807 testes críticos em 98 arquivos, 85 testes de processos em Node e 3 testes de scripts aprovados; também passaram os 66 testes focados e o cenário de navegador. Typecheck de backend/dashboard e build concluídos.

O pacote contém 2.434 módulos alcançáveis e 42 dependências, sem módulos faltantes. Renderer, IPC/backend, deep link, indexador, QuickJS, conversão web e visão com Sharp/FFmpeg passaram. Os 24 módulos de produção alterados coincidem byte a byte com o build validado; nenhum caminho do runtime Rust retirado reapareceu. O executável abriu e fechou sem processos de teste remanescentes. Relatórios: `.tmp/ultra-installer-verify.json`, `.tmp/ultra-packaged-boot.json` e `.tmp/ultra-package-source-audit.json`.

Integridade NSIS aprovada pelo 7-Zip. Tamanho: 293.420.977 bytes. SHA-256: `d7b30e844befefc1e9ee9e53977803155f9a6011a35719433eda839333dd42a3`. Assinatura Authenticode: `NotSigned`.
