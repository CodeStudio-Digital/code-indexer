import { buildFtsMatch, ftsTokens } from '@mcp/store/db/fts-query.js';
import { lexicalQuery, planQuery } from './planner.js';

// Small, deterministic programming vocabulary for Portuguese prose over code
// and comments commonly written in English. Exact identifiers/paths keep the
// normal lexical contract. This is recall expansion, not query translation.
const groups: Array<[string, string]> = [
  ['arquivo arquivos', 'file files filename filenames'],
  ['pasta pastas diretório diretórios', 'directory directories folder folders'],
  ['caminho caminhos', 'path paths'],
  ['nome nomes', 'name names'],
  ['função funções método métodos', 'function functions method methods'],
  ['classe classes declaração declarações', 'class declaration declarations'],
  ['símbolo símbolos identificador identificadores', 'symbol symbols identifier identifiers'],
  ['chama chamam chamada chamadas', 'call calls caller invoke invokes'],
  ['referência referências', 'reference references'],
  ['consulta consultas', 'query queries'],
  ['banco bancos', 'database databases'],
  ['tabela tabelas', 'table tables'],
  ['coluna colunas', 'column columns'],
  ['linha linhas registro registros', 'row rows record records'],
  ['chave chaves', 'key keys'],
  ['primária primárias', 'primary'],
  ['conexão conexões', 'connection connections'],
  ['configuração configurações', 'configuration config settings'],
  ['usuário usuários identidade', 'user users identity subject'],
  ['sessão sessões', 'session sessions'],
  ['senha senhas', 'password passwords'],
  ['credencial credenciais autenticação', 'credential credentials authentication token tokens'],
  ['validade expiração vencimento venceu expirada', 'expiry expiration expired expires'],
  ['permissão permissões autorização', 'permission permissions authorization'],
  ['ferramenta ferramentas capacidade capacidades', 'tool tools capability capabilities'],
  ['parâmetro parâmetros argumento argumentos', 'parameter parameters argument arguments'],
  ['processo processos execução execuções', 'process processes execution executions'],
  ['comando comandos', 'command commands'],
  ['saída saídas', 'output stdout stderr'],
  ['log logs', 'log logs stdout stderr spool'],
  ['página páginas paginação', 'page pages pagination cursor'],
  ['limite limites limitado limitada', 'limit limits bounded'],
  ['memória', 'memory'],
  ['prazo duração tempo', 'deadline duration time timeout'],
  ['cancelamento cancela cancelar', 'cancel cancellation abort'],
  ['erro erros falha falhas', 'error errors failure failures failed'],
  ['sucesso', 'success succeeded'],
  ['tarefa tarefas trabalho', 'task tasks job jobs work'],
  ['índice indexação', 'index indexed indexing'],
  ['busca pesquisa', 'search retrieval'],
  ['cache respostas', 'cache cached results'],
  ['antigo antiga antigos antigas obsoleto obsoleta', 'stale obsolete outdated'],
  ['atualização atualizações alteração alterações mudança mudanças', 'update updates change changes'],
  ['versão versões revisão revisões', 'version versions revision revisions'],
  ['geração gerações', 'generation generations'],
  ['escrita escreve gravar', 'write writes writing'],
  ['leitura ler', 'read reads reading'],
  ['edição editar', 'edit editing'],
  ['exportação exportar', 'export exports'],
  ['importação importar restauração', 'import restore'],
  ['transação transações', 'transaction transactions'],
  ['confirma confirmar', 'commit committed confirm'],
  ['reiniciar reinício', 'restart restarting'],
  ['remoto remota remotos remotas', 'remote'],
  ['imagem imagens', 'image images picture pictures'],
  ['objeto objetos', 'object objects'],
];
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const aliases = new Map(groups.flatMap(([pt, en]) => pt.split(' ').map(word => [fold(word), en.split(' ')] as const)));

export function buildConceptFtsMatch(query: string, connector: 'AND' | 'OR'): string {
  const lexical = lexicalQuery(query);
  if (planQuery(query).mode !== 'hybrid') return buildFtsMatch(lexical, connector);
  return ftsTokens(lexical).slice(0, 24).map(token => {
    const alternatives = [token, ...(aliases.get(fold(token)) ?? [])];
    const quoted = alternatives.map(value => buildFtsMatch(value, 'OR'));
    return quoted.length > 1 ? `(${quoted.join(' OR ')})` : quoted[0];
  }).join(` ${connector} `);
}
