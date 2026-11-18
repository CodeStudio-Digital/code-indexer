import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { ApiError, type FigmaConnectionCommand, type FigmaConnectionStatus } from '@mcp/api-bus';
import type { EmbeddedMcpConfig } from '@mcp/code-agent/tools/mcp-connection-types.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import { PluginStorageStore } from '@mcp/store/plugin-storage-store.js';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { getMainSecretDecryptor, getMainSecretEncryptor } from '../secret-decrypt-port.js';
import { FigmaApiError, FigmaClient, object } from './client.js';
import { FIGMA_TOOLS, openFigmaMcp } from './mcp-tools.js';
import { FigmaProjectCache } from './project-cache.js';

export const FIGMA_PLUGIN = 'figma';
export const FIGMA_SERVER_ID = 'codestudio-figma';
const CONNECTION_KEY = 'mcp.connection';
type StoredConnection = { encryptedToken: string; account: string; revision: string };

export class BundledFigmaMcp {
  private readonly installed: InstalledPluginStore;
  private readonly storage: PluginStorageStore;
  private readonly registeredServers: McpServerStore;
  private pendingChange = 0;

  /** Set by the application after the shared MCP pool is available. */
  refresh?: () => Promise<unknown>;

  constructor(db: Database, private readonly fetcher?: typeof fetch,
    private readonly cache = new FigmaProjectCache(join(mcpDataDir(), 'cache', 'figma-v1'))) {
    this.installed = new InstalledPluginStore(db);
    this.storage = new PluginStorageStore(db);
    this.registeredServers = new McpServerStore(db);
  }

  private available(): boolean {
    const plugin = this.installed.get(FIGMA_PLUGIN);
    return !!plugin?.enabled && plugin.source === 'bundled' && plugin.name === FIGMA_PLUGIN;
  }

  private stored(): StoredConnection | null {
    if (!this.available()) return null;
    const row = this.storage.get(FIGMA_PLUGIN, CONNECTION_KEY);
    if (!row) return null;
    try {
      const { encryptedToken, account, revision } = object(JSON.parse(row));
      if (typeof encryptedToken === 'string' && encryptedToken.startsWith('enc:')
        && typeof account === 'string' && typeof revision === 'string') return { encryptedToken, account, revision };
    } catch { /* A damaged record can be replaced from the panel. */ }
    return null;
  }

  private status(): FigmaConnectionStatus {
    const current = this.stored();
    return { connected: !!current, account: current?.account ?? null, toolCount: current ? FIGMA_TOOLS.length : 0 };
  }

  private async client(revision?: string): Promise<FigmaClient> {
    const current = this.stored();
    if (!current || (revision !== undefined && revision !== current.revision)) {
      throw new ApiError('figma_disconnected', 409, 'Connect or reconnect Figma from its CodeStudio panel.');
    }
    let token: string;
    try { token = await getMainSecretDecryptor()(current.encryptedToken); }
    catch { throw new ApiError('figma_keychain', 409, 'Reconnect Figma to use the token from this desktop profile.'); }
    if (!token || this.stored()?.revision !== current.revision) {
      throw new ApiError('figma_disconnected', 409, 'The Figma connection changed. Retry with its current configuration.');
    }
    return new FigmaClient(token, this.fetcher);
  }

  private async sameToken(previous: StoredConnection, token: string): Promise<boolean> {
    try { return await getMainSecretDecryptor()(previous.encryptedToken) === token; }
    catch { return false; }
  }

  private async checkAccount(client: FigmaClient, signal: AbortSignal): Promise<string> {
    try { return await client.account(signal); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof FigmaApiError) throw new ApiError('figma_api', error.status, error.message);
      throw new ApiError('figma_unavailable', 502, 'Could not verify the token with Figma. Check the connection and try again.');
    }
  }

  async manage(command: FigmaConnectionCommand, signal: AbortSignal): Promise<FigmaConnectionStatus> {
    if (!this.available()) throw new ApiError('figma_unavailable', 404, 'Enable the bundled Figma plugin to connect.');
    signal.throwIfAborted();
    if (command.action === 'status') return this.status();
    if (command.action === 'test') {
      await this.checkAccount(await this.client(), signal);
      return this.status();
    }
    if (command.action === 'disconnect') {
      this.pendingChange++;
      const previous = this.stored();
      this.storage.delete(FIGMA_PLUGIN, CONNECTION_KEY);
      if (previous) await this.cache.retire(previous.revision);
      await this.refresh?.();
      return this.status();
    }
    if (command.action !== 'connect') throw new ApiError('invalid_input', 400, 'Invalid Figma connection action.');
    const token = typeof command.token === 'string' ? command.token.trim() : '';
    if (!token || token.length > 1024 || /[^\x21-\x7e]/.test(token)) {
      throw new ApiError('invalid_input', 400, 'Enter a Figma personal access token.');
    }
    if (this.registeredServers.getServer(FIGMA_SERVER_ID)) {
      throw new ApiError('figma_mcp_conflict', 409, 'The MCP server ID codestudio-figma is already in use.');
    }
    const change = ++this.pendingChange;
    const previous = this.stored();
    const account = await this.checkAccount(new FigmaClient(token, this.fetcher), signal);
    let encryptedToken: string;
    try { encryptedToken = await getMainSecretEncryptor()(token); }
    catch { throw new ApiError('figma_keychain', 503, 'Enable the desktop keychain to save the Figma token.'); }
    if (!encryptedToken.startsWith('enc:')) throw new ApiError('figma_keychain', 503, 'Enable the desktop keychain to save the Figma token.');
    const revision = previous && await this.sameToken(previous, token) ? previous.revision : randomUUID();
    signal.throwIfAborted();
    if (this.pendingChange !== change || !this.available()) {
      throw new ApiError('figma_connection_changed', 409, 'The Figma connection was changed while verification was running.');
    }
    this.storage.set(FIGMA_PLUGIN, CONNECTION_KEY, JSON.stringify({ encryptedToken, account, revision }));
    if (previous && previous.revision !== revision) await this.cache.retire(previous.revision);
    await this.refresh?.();
    return this.status();
  }

  readConfig(): EmbeddedMcpConfig | null {
    const current = this.stored();
    if (!current) return null;
    return {
      id: FIGMA_SERVER_ID, name: 'Figma', enabled: true, transport: 'embedded',
      url: null, command: null, args: [], env: {}, auth_type: 'none', auth_token: null,
      default_tier: 'navigate', config: { revision: current.revision }, created_at: '', updated_at: '',
    };
  }

  connect(config: EmbeddedMcpConfig) {
    const revision = config.config.revision;
    if (config.id !== FIGMA_SERVER_ID || typeof revision !== 'string') throw new Error('Invalid embedded Figma MCP source.');
    return openFigmaMcp(this.cache, revision, () => {
      if (this.stored()?.revision !== revision) {
        throw new ApiError('figma_disconnected', 409, 'The Figma connection changed. Retry with its current configuration.');
      }
    }, () => this.client(revision));
  }
}
