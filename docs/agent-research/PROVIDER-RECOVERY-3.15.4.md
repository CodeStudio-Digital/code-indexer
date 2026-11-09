# Recuperação de transporte — CodeStudio 3.15.4

## Incidente observado em 27/10/2026

A sessão `95ec3e6f-ebd3-4950-8796-63f55a641b19` encerrou a execução
`d3524e78-a676-4251-9a04-06fb63f45a5b` às 18:10:49 UTC com
`Recovery cap exceeded (kind=provider-unknown-retry 5/4): terminated`.

Os registros locais em `metrics/provider_attempts` mostram 72 chamadas:
67 bem-sucedidas, quatro `TIMEOUT` nas chamadas 9, 13, 17 e 18 e um
`TypeError` na chamada 72. A chamada 71 terminou com sucesso às 18:09:27 UTC.
As cinco ocorrências não eram cinco falhas consecutivas da mesma resposta.

O fetch nativo do Node/Undici cria `TypeError('terminated', { cause })`
quando a leitura do corpo HTTP termina por erro. O classificador anterior
ignorava `cause`, e a telemetria de fallback persistia apenas `TypeError`.
Portanto, não existe evidência histórica suficiente para atribuir o fechamento
específico a rede local, proxy ou servidor. Não há indicação de término de um
comando de shell nesse erro. Uma desconexão HTTP local reproduziu a mensagem
com a causa `UND_ERR_SOCKET`.

## Correção

- Diagnóstico limitado à cadeia de causas, com códigos de transporte conhecidos.
  Preserva `UND_ERR_SOCKET`, `ECONNRESET`, timeouts e demais códigos suportados,
  sem registrar URLs, headers, prompts, credenciais ou endereços de sockets.
- Falhas de transporte usam um limite consecutivo de até quatro recuperações
  (ou o limite mais restritivo da política). Uma resposta terminal válida e
  utilizável reinicia essa sequência; texto parcial não reinicia nada.
- O total de falhas de transporte e HTTP transitórias compartilha o limite
  existente de 30 por execução, sujeito à política. Os limites de erro
  desconhecido, autenticação e raciocínio permanecem separados.
- `response.completed` encerra a leitura da resposta ChatGPT, sem aguardar EOF
  do socket. A camada comum também reconhece desconexões tardias após `done`.
  Uma desconexão anterior ao resultado terminal continua sendo uma falha.
- Eventos `error`, `response.failed` e `response.incomplete` conservam o código
  estruturado. Uma resposta incompleta não é convertida em sucesso nem repetida
  cegamente com o mesmo pedido.
- Cancelamento interrompe a espera de recuperação. Ferramentas de uma resposta
  interrompida não são despachadas; a retomada usa o histórico confirmado.
  `TOOL_OUTCOME_UNKNOWN` continua exigindo reconciliação.

Contrato público de referência:
[Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses).
Não foi ativado armazenamento remoto, alterado modelo/esforço ou acessada a
conta do usuário para produzir a validação.

## Evidências

- `.tmp/provider-terminated-before.log`: duas regressões reproduzidas antes da
  correção (fechamento após terminal e perda do código em `cause`).
- `.tmp/provider-terminated-focused.log`: testes de classificação, recuperação,
  cancelamento, despacho único, adaptador e preservação dos totais.
- `.tmp/provider-terminated-integration.log`: HTTP/SSE real em loopback, SDK real
  e fetch nativo; desconexão antes do terminal, corpo mantido aberto após o
  terminal, EOF sem terminal, preservação do bloqueio de efeitos incertos.
- `scripts/release/provider-recovery-smoke.cjs`: a mesma fronteira HTTP e a
  recuperação exercitadas nos módulos extraídos do pacote Electron.

O teste local prova o comportamento do cliente sob essas falhas, não que redes
ou provedores externos nunca mais interromperão conexões.

## Entrega Windows x64 — 27/10/2026

- Instalador: `D:\MCP\dist\releases\provider-recovery-3.15.4\CodeStudio Setup 3.15.4.exe`.
- Tamanho: **340.953.894 bytes**.
- SHA-256: `c8e7bcba06902a282e75d3d6ae09f298d434b76e9213aa7ada38a18936f03275`.
- **141 testes aprovados**: 128 testes focados e 13 de integração.
- Compilação de produção, verificação de tipos e build da interface aprovados.
  Log: `.tmp/provider-recovery-3.15.4-build.log`.
- **Três verificações aprovadas no aplicativo empacotado**, usando o runtime
  Electron: classificação/terminal, recuperação limitada e desconexão HTTP real.
  Relatório: `dist/releases/provider-recovery-3.15.4/validation/provider-recovery-smoke.json`.
- `app.asar` e `CodeStudio.exe` extraídos do instalador têm os mesmos hashes
  dos arquivos validados. Tamanho e SHA-512 conferem com `latest.yml`.
- Closure aprovada: 2.442 módulos e 42 pacotes, sem dependências ausentes.
  Relatório: `dist/releases/provider-recovery-3.15.4/installer-verification.json`;
  hash distribuído em `SHA256SUMS.txt`, na mesma pasta.

Os processos próprios de build e validação terminaram. Não houve chamadas de
inferência externas, instalação sobre o aplicativo atual ou alteração do perfil
e do histórico do usuário nesta entrega.
