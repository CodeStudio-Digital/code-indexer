import { chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface SecretSealer {
  seal(plaintextOrCiphertext: string): string;
}

const encryptedPrefixes = ['enc:', 'v1:'] as const;
const plaintextPrefixes = ['plain:', 'dev-plain:'] as const;

function decodeTaggedPlaintext(value: string): string {
  const prefix = plaintextPrefixes.find((candidate) => value.startsWith(candidate));
  if (!prefix) return value;
  return Buffer.from(value.slice(prefix.length), 'base64').toString('utf8');
}

export async function createElectronSecretSealer(): Promise<SecretSealer> {
  const electron = await import('electron') as unknown as {
    app?: { whenReady(): Promise<void> };
    safeStorage?: {
      isEncryptionAvailable(): boolean;
      encryptString(value: string): Buffer;
      decryptString(value: Buffer): string;
    };
  };
  if (!electron.app || !electron.safeStorage) {
    throw new Error(
      'Electron safeStorage is unavailable; run the migration as an Electron main process, not ELECTRON_RUN_AS_NODE',
    );
  }
  await electron.app.whenReady();
  if (!electron.safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is unavailable; refusing to migrate Company plaintext secrets');
  }

  return {
    seal(value: string): string {
      if (!value) return '';
      if (encryptedPrefixes.some((prefix) => value.startsWith(prefix))) {
        if (value.startsWith('enc:')) {
          // Fail closed if the current OS user cannot decrypt the legacy blob.
          electron.safeStorage!.decryptString(Buffer.from(value.slice(4), 'base64'));
        }
        return value;
      }
      const plaintext = decodeTaggedPlaintext(value);
      return `enc:${electron.safeStorage!.encryptString(plaintext).toString('base64')}`;
    },
  };
}

export function protectSecretPath(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
    return;
  }
  const identity = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
  if (!identity) throw new Error('cannot determine Windows identity for Company secret ACL');
  execFileSync(
    'icacls.exe',
    [path, '/inheritance:r', '/grant:r', `${identity}:(F)`],
    { encoding: 'utf8', windowsHide: true },
  );
}

export function sealCompanyEnvironmentRow(
  row: Record<string, unknown>,
  sealer: SecretSealer,
): Record<string, unknown> {
  if (!row.is_secret) return row;
  const value = row.value;
  if (typeof value !== 'string') {
    throw new Error('Company secret row has no string value');
  }
  const sealed = sealer.seal(value);
  return {
    ...row,
    value: undefined,
    encrypted_value: sealed,
    encryption: sealed.startsWith('enc:') ? 'electron_safe_storage' : 'vault',
  };
}

