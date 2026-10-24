# Fronteiras verificadas no monorepo

`pnpm check:boundaries` verifica imports, dependências declaradas e artefatos
rastreados. O baseline é uma dívida histórica: mudanças podem removê-la, mas
não devem acrescentar violações para tornar o comando verde.

## Contratos e implementações

`allowedCrossDomainPackages` contém pacotes que são, por inteiro, APIs do
produtor: contratos de providers, lifecycle do agente e bus de operações.
Os nomes atuais são `@mcp/*`; os nomes `@codestudio/*` no plano histórico de
separação não substituem os contratos existentes.

Pacotes que também contêm implementação têm APIs menores em
`allowedCrossDomainImports`. A lista aceita o specifier completo, não todos
os módulos do pacote. Exemplos são o protocolo de preview, os payloads do
inspector, a política de anexos e o port de renderização de diagramas. Essas
entradas possuem exports explícitos em seus manifests. Importar um módulo
interno vizinho continua proibido.

`allowedWorkspacePackages` identifica os contratos que são construídos juntos
neste monorepo. Isso permite sua dependência `workspace:*` sem exigir uma
publicação npm fictícia. O controle de imports continua independente; permitir
a versão workspace de um pacote não libera seus módulos internos.

## Composição das aplicações

As aplicações usam o manifesto raiz para o build agregado. Herdar uma
dependência dessa raiz não transforma cada pasta em um workspace independente.
O checker ainda verifica a direção do import, mas não atribui uma dependência
workspace fictícia à aplicação que não possui manifesto próprio.

Imports entre aplicações do mesmo domínio passam somente pelos caminhos
exatos em `unitEntrypoints`:

- `apps/http-api/public.ts` oferece o runtime CLI com request, projetos e close.
- `apps/mcp-server/agent-read-client.ts` oferece leitura de catálogo e runs por
  transporte injetado; não expõe banco, admission, start ou cancel.

Imports de internals entre aplicações e imports entre domínios permanecem
proibidos. Fixtures de renderer pertencem ao dashboard; testes da integração
MCP pertencem ao servidor MCP. O gerador do catálogo também pertence ao seu
produtor e continua validando o artefato consumido pelo code-agent no build.

`runtimeModules` é uma lista por arquivo para módulos fornecidos pelo runtime.
O harness de compatibilidade de sessões usa `original-fs` do Electron para
ler o arquivo ASAR bruto; isso não instala um pacote npm com o mesmo nome.

## Dependências do instalador

O build desktop reúne o código emitido dos workspaces em `dist`, dentro de um
único pacote de aplicação. Por isso as dependências externas de produção dos
pacotes também precisam constar no manifesto raiz. O script
`scripts/check-desktop-runtime-dependencies.mjs`, executado pelo build Electron,
verifica esse espelhamento; dependências internas `@mcp/*` da raiz ficam em
`devDependencies`, pois são resolvidas no código emitido.

O Knip analisa cada workspace separadamente e não reconhece esse consumo pelo
artefato agregado. A lista `workspaces["."].ignoreDependencies` contém somente
os módulos de produção espelhados que ele reporta como ociosos na raiz, além
do builtin Electron `original-fs`. Seus consumidores permanecem analisados nos
pacotes: Bedrock/Transformers no indexer, parser/MagicString/Office/QuickJS nos
services, e OpenAI/cores/HTML no code-agent. A lista não permite imports ou
dependências sem declaração em outros workspaces.
