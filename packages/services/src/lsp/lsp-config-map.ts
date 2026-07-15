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

/**
 * Intelephense 1.12.6 defaults. `intelephense.stubs` replaces this list rather
 * than extending it, so any dynamic extension must be sent as a full union.
 */
export const INTELEPHENSE_DEFAULT_STUBS = [
  'apache', 'bcmath', 'bz2', 'calendar', 'com_dotnet', 'Core', 'ctype', 'curl',
  'date', 'dba', 'dom', 'enchant', 'exif', 'FFI', 'fileinfo', 'filter', 'fpm',
  'ftp', 'gd', 'gettext', 'gmp', 'hash', 'iconv', 'imap', 'intl', 'json', 'ldap',
  'libxml', 'mbstring', 'meta', 'mysqli', 'oci8', 'odbc', 'openssl', 'pcntl',
  'pcre', 'PDO', 'pdo_ibm', 'pdo_mysql', 'pdo_pgsql', 'pdo_sqlite', 'pgsql',
  'Phar', 'posix', 'pspell', 'random', 'readline', 'Reflection', 'session',
  'shmop', 'SimpleXML', 'snmp', 'soap', 'sockets', 'sodium', 'SPL', 'sqlite3',
  'standard', 'superglobals', 'sysvmsg', 'sysvsem', 'sysvshm', 'tidy',
  'tokenizer', 'xml', 'xmlreader', 'xmlrpc', 'xmlwriter', 'xsl', 'Zend OPcache',
  'zip', 'zlib',
] as const;

// Pin this catalog to the bundled Intelephense version. Runtime module names
// are matched case-insensitively, then restored to the canonical stub spelling.
const INTELEPHENSE_SUPPORTED_STUBS = [
  ...`aerospike amqp apache apcu ast bcmath blackfire bz2 calendar cassandra
  com_dotnet Core couchbase couchbase_v2 crypto ctype cubrid curl date dba decimal
  dio dom ds eio elastic_apm enchant Ev event exif expect fann FFI ffmpeg fileinfo
  filter fpm ftp gd gearman geoip geos gettext gmagick gmp gnupg grpc hash http
  ibm_db2 iconv igbinary imagick imap inotify interbase intl json judy ldap leveldb
  libevent libsodium libvirt-php libxml lua LuaSandbox lzf mailparse mapscript
  mbstring mcrypt memcache memcached meminfo meta ming mongo mongodb mosquitto-php
  mqseries msgpack mssql mysql mysql_xdevapi mysqli ncurses newrelic oauth oci8 odbc
  openssl opentelemetry pam parallel Parle pcntl pcov pcre pdflib PDO pdo_ibm
  pdo_mysql pdo_pgsql pdo_sqlite pgsql Phar phpdbg posix pq pspell pthreads radius
  random rar rdkafka readline recode redis Reflection regex relay rpminfo rrd SaxonC
  session shmop simple_kafka_client SimpleXML snappy snmp soap sockets sodium solr
  SPL SplType SQLite sqlite3 sqlsrv ssh2 standard stats stomp suhosin superglobals
  svm svn swoole sybase sync sysvmsg sysvsem sysvshm tidy tokenizer uopz
  uploadprogress uuid uv v8js wddx win32service winbinder wincache wordpress xcache
  xdebug xdiff xhprof xlswriter xml xmlreader xmlrpc xmlwriter xsl xxtea yaf yaml yar
  zend ZendCache ZendDebugger ZendUtils zip zlib zmq zookeeper zstd`.trim().split(/\s+/),
  'Zend OPcache',
] as const;

const INTELEPHENSE_STUB_BY_LOWER_NAME = new Map(
  INTELEPHENSE_SUPPORTED_STUBS.map((name) => [name.toLowerCase(), name]),
);
const INTELEPHENSE_DEFAULT_STUB_SET = new Set<string>(INTELEPHENSE_DEFAULT_STUBS);
const INTELEPHENSE_EXTENSION_ALIASES = new Map<string, string>([
  ['opcache', 'Zend OPcache'],
  ['zend opcache', 'Zend OPcache'],
]);

/** Full default+extra stub union, or undefined when no loaded extra is needed. */
export function intelephenseStubsForExtensions(extensionNames: readonly string[]): string[] | undefined {
  const extras = new Set<string>();
  for (const extensionName of extensionNames) {
    const normalized = extensionName.trim().toLowerCase();
    const stub = INTELEPHENSE_EXTENSION_ALIASES.get(normalized)
      ?? INTELEPHENSE_STUB_BY_LOWER_NAME.get(normalized);
    if (stub && !INTELEPHENSE_DEFAULT_STUB_SET.has(stub)) extras.add(stub);
  }
  if (extras.size === 0) return undefined;
  return [...INTELEPHENSE_DEFAULT_STUBS, ...[...extras].sort((a, b) => a.localeCompare(b))];
}

export interface LspProjectConfigContext {
  /** PHP modules confirmed loaded by the project's selected managed runtime. */
  phpExtensions?: readonly string[];
}

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
 * Project-import defaults for the standalone JDT LS client. vscode-java sends
 * the same `settings.java` shape during initialize; without it JDT LS keeps
 * build-file changes interactive, but this client has no VS Code prompt flow.
 */
export function jdtJavaSettings(): Record<string, unknown> {
  return {
    autobuild: { enabled: true },
    configuration: { updateBuildConfiguration: 'automatic' },
    import: {
      maven: { enabled: true },
      gradle: { enabled: true, wrapper: { enabled: true } },
    },
    maven: { downloadSources: true },
    eclipse: { downloadSources: true },
    compile: { nullAnalysis: { mode: 'automatic' } },
    symbols: { includeGeneratedCode: true },
    errors: { incompleteClasspath: { severity: 'warning' } },
  };
}

function nestedSetting(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
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
export function mapLspConfigSection(
  serverId: string,
  section: string | null,
  levels: LangLevels,
  context: LspProjectConfigContext = {},
): unknown {
  const level = languageLevelForServer(serverId, levels);

  if (serverId === 'jdtls') {
    const settings = jdtJavaSettings();
    if (section == null || section === 'java') return settings;
    if (section.startsWith('java.')) return nestedSetting(settings, section.slice(5).split('.'));
    return null;
  }

  if (serverId === 'intelephense') {
    // intelephense lê `intelephense.environment.phpVersion` (pede a seção 'intelephense').
    if (section == null || section === 'intelephense') {
      const settings: { environment?: { phpVersion: string }; stubs?: string[] } = {};
      if (level) settings.environment = { phpVersion: level };
      const stubs = intelephenseStubsForExtensions(context.phpExtensions ?? []);
      if (stubs) settings.stubs = stubs;
      if (settings.environment || settings.stubs) return settings;
    }
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
