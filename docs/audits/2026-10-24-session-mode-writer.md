# Falha ao enviar após trocar o modo do agente

## Diagnóstico

O registro correspondente ao print de `request-setup-failed` contém `error:SessionLeaseHeldError`. A resposta anterior estava persistida, a troca de Explore para Build estava pendente e o envio seguinte falhou antes de iniciar a inferência.

A rota HTTP materializava a troca de modo com seu próprio `FsSessionStore`. O worker anterior ainda mantinha o writer exclusivo durante a janela de reutilização. Consumir a transição pelo servidor exigia adquirir esse mesmo writer e falhava. O bloqueio protegia corretamente o histórico; o erro estava em escolher o processo errado para gravá-lo.

## Correção

A materialização passou para a preparação de `runFresh` no worker, depois da aquisição do writer e antes de construir o runner. Tanto o envio normal quanto a continuação usam esse caminho. A rota HTTP deixa de consumir a transição ou inserir o lembrete.

O lembrete preserva a orientação de usar o novo modo e os registros recebem IDs de operação derivados da transição. Não há liberação forçada de leases nem reexecução automática de mensagens. Esta correção trata a causa confirmada; `request-setup-failed` também pode representar outras falhas de preparação.

## Validação

O teste de integração usa dois stores reais e o mesmo bundle: o acesso pelo servidor reproduz `SessionLeaseHeldError`; o worker persiste a troca. Alternâncias Build → Plan → Explore → Build, com chamadas repetidas de preparação, mantêm um lembrete e um registro por transição. Os testes das rotas de envio e continuação também verificam que o servidor não tenta consumir a transição do worker.

A seleção rápida inclui esses fluxos e os testes existentes de idempotência. Não foram acrescentados testes de apresentação ou snapshots de implementação.

O checkout compartilhado contém trabalho paralelo. A validação do pacote usa uma exportação de `2658332a` com somente os arquivos desta correção; dependências instaladas são reutilizadas. No checkout compartilhado, uma asserção de estado inicial divergiu pela adição paralela de `worktree_path: null`. Essa alteração não integra este pacote.

- Suíte isolada: 772 testes em Electron, 85 em Node e 3 verificações de scripts de build, todos aprovados.
- Typecheck do backend e dashboard e compilação de produção aprovados.
- Limite de linhas sem violações graves; nenhum ciclo de importação.
- Relatórios locais: `.tmp/session-mode-release-quick.log`, `.tmp/session-mode-release-build.log`, `.tmp/session-mode-dashboard-types.log`, `.tmp/session-mode-release-loc.log` e `.tmp/session-mode-cycles.log`.

## Instalador

`dist/electron-session-mode-20261024/CodeStudio Setup 3.15.1.exe`, 293.410.977 bytes. SHA-256: `9251e37f71635cb2947b2d8f11fc4baa6b9549a0d4e0cbd971f7bacda9431500`.

Integridade do instalador aprovada com o 7-Zip instalado. A versão antiga do 7zip-bin não reconhece o filtro ARM64 usado pelo empacotador atual; ela não foi usada como resultado final.

O pacote passou na verificação de 2.421 módulos alcançáveis e 42 pacotes, renderer, deep link, indexador, QuickJS, conversão web e visão. A inicialização do executável em perfil isolado confirmou IPC e backend, sem erros de console e sem processos de teste restantes. Os três módulos alterados no ASAR coincidem byte a byte com o build isolado. O runtime Rust removido não voltou ao pacote.

Build de desenvolvimento sem assinatura. O aplicativo instalado do usuário não foi substituído. Relatórios: `.tmp/session-mode-installer-verify.json`, `.tmp/session-mode-packaged-boot.json`, `.tmp/session-mode-rust-path-audit.json` e `.tmp/session-mode-installer-integrity.log`.
