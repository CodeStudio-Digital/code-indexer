/**
 * SecureTokenStore — persists the rotating REFRESH token, encrypted at rest via
 * the OS keychain (`safeStorage`). It lives ONLY in the main process; the renderer
 * never sees the refresh token (an XSS foothold in the large React bundle must not
 * be able to exfiltrate it). The factory is fully injectable (no top-level
 * `electron` import) so the logic is unit-testable with fakes.
 */
export interface SecureTokenStore {
  setRefreshToken(token: string): Promise<void>;
  /** null when never logged in OR the keychain blob can't be decrypted. */
  getRefreshToken(): Promise<string | null>;
  clear(): Promise<void>;
  /** false ⇒ no OS keychain (rare Linux); caller degrades to session-only login. */
  isHardwareBacked(): boolean;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
}
export interface FsLike {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  rm(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export function createSafeStorageTokenStore(deps: {
  safeStorage: SafeStorageLike;
  fs: FsLike;
  filePath: string;
  dir: string;
}): SecureTokenStore {
  const { safeStorage, fs, filePath, dir } = deps;
  return {
    isHardwareBacked: () => safeStorage.isEncryptionAvailable(),
    async setRefreshToken(token) {
      await fs.mkdir(dir).catch(() => {});
      await fs.writeFile(filePath, safeStorage.encryptString(token));
    },
    async getRefreshToken() {
      try {
        const buf = await fs.readFile(filePath);
        return safeStorage.decryptString(buf);
      } catch {
        return null; // missing file or undecryptable ⇒ treat as logged out
      }
    },
    async clear() {
      await fs.rm(filePath).catch(() => {});
    },
  };
}
