/**
 * Mapa ISOLADO entre a versão da linguagem (LangLevels) e a config que CADA servidor
 * LSP entende. Este é o ÚNICO lugar que conhece os nomes de chave server-específicos
 * (`intelephense.environment.phpVersion`, `python.analysis.pythonVersion`) — se a doc
 * de um server divergir, muda-se só aqui.
 *
 * ⚠️ A CONFIRMAR no device (ver plano): rodar com MCP_LSP_DEBUG=1 e ler a `section`
 * que cada server pede no `workspace/configuration`, e o formato de versão aceito
 * (ex.: "8.2" vs "8.2.0"). Os pacotes são pinados (intelephense 1.12.6 / pyright 1.1.405).
 */
import type { LangLevels, LangLevelKey } from '@mcp/shared/utils/language-levels.js';

/** serverId → qual chave de linguagem dirige sua versão. */
const SERVER_LANG: Record<string, LangLevelKey> = {
  intelephense: 'php',
  pyright: 'python',
};

/** Versão escolhida que se aplica a este server, ou undefined (= usar default do server). */
export function languageLevelForServer(serverId: string, levels: LangLevels): string | undefined {
  const lang = SERVER_LANG[serverId];
  return lang ? levels[lang] : undefined;
}

/**
 * Resposta para um item de `workspace/configuration` (server pediu `section`).
 * Devolve SÓ a versão da linguagem (quando setada); `null` caso contrário = "use seus defaults".
 *
 * ⚠️ NÃO enviar um objeto `completion`/`analysis` PARCIAL (ex.: `{ completion: { insertUseDeclaration } }`):
 * o Intelephense aplica só o que mandamos e perde os defaults de completion (notadamente `maxItems`
 * 100 → 0) → completion VAZIA. O auto-import já é default do servidor (insertUseDeclaration/
 * autoImportCompletions = true) e é dirigido pelas capabilities `resolveSupport`, não por esta config.
 */
export function mapLspConfigSection(serverId: string, section: string | null, levels: LangLevels): unknown {
  const level = languageLevelForServer(serverId, levels);

  if (serverId === 'intelephense') {
    // intelephense lê `intelephense.environment.phpVersion` (pede a seção 'intelephense').
    if ((section == null || section === 'intelephense') && level) return { environment: { phpVersion: level } };
    return null;
  }

  if (serverId === 'pyright') {
    // pyright lê `python.analysis.pythonVersion` (pede 'python' e/ou 'python.analysis').
    if (section === 'python' && level) return { analysis: { pythonVersion: level } };
    if (section === 'python.analysis' && level) return { pythonVersion: level };
    return null;
  }

  return null;
}

/**
 * Bloco a fundir no `initializationOptions` do server (via redundante à
 * `workspace/configuration`). Só o intelephense lê a versão por aqui hoje; o pyright
 * é coberto 100% pela `workspace/configuration`.
 */
export function initOptionsForServer(serverId: string, level: string | undefined): Record<string, unknown> | undefined {
  if (!level) return undefined;
  if (serverId === 'intelephense') return { environment: { phpVersion: level } };
  return undefined;
}
