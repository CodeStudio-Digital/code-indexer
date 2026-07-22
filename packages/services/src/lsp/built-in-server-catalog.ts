import { join } from 'node:path';
import { initOptionsForServer, jdtJavaSettings } from './lsp-config-map.js';
import { jdtlsSpawnSpec, omnisharpSpawnSpec } from './java-csharp-launch.js';
import {
  SUPPORTED_LSP_TARGETS,
  type LspBinaryAsset,
  type LspServerDef,
  type LspTargetKey,
} from './lsp-server-types.js';

const RA_BASE = 'https://github.com/rust-lang/rust-analyzer/releases/download/2025-01-20';
const RUFF_BASE = 'https://github.com/astral-sh/ruff/releases/download/0.11.13';
const JDTLS_URL = 'https://download.eclipse.org/jdtls/milestones/1.60.0/jdt-language-server-1.60.0-202606262232.tar.gz';
const JDTLS_SHA256 = 'e94c303d8198f977930803582738771fd18c52c5492878410bf222b1aa81ef1d';
const JDTLS_LAUNCHER = 'plugins/org.eclipse.equinox.launcher_1.7.200.v20260619-2039.jar';
export const JDTLS_LOMBOK_RELPATH = 'lombok/lombok-1.18.46.jar';
const JDTLS_LOMBOK_URL = 'https://projectlombok.org/downloads/lombok-1.18.46.jar';
const JDTLS_LOMBOK_SHA256 = '01f7b1a015e33e2b62d5f5f37053306357ab1415fd181fcba7794f5d198c1126';
const OMNISHARP_BASE = 'https://github.com/OmniSharp/omnisharp-roslyn/releases/download/v1.39.15';

export const LSP_SERVER_REGISTRY: readonly LspServerDef[] = [
  {
    id: 'intelephense', label: 'Intelephense (PHP)', languages: ['php'],
    install: { kind: 'npm', package: 'intelephense', version: '1.12.6' },
    entryRelPath: 'node_modules/intelephense/lib/intelephense.js', args: ['--stdio'], sizeLabel: '~25 MB',
    initializationOptions: ({ cacheDir, languageLevel }) => ({
      storagePath: join(cacheDir, 'intelephense'),
      ...(initOptionsForServer('intelephense', languageLevel) ?? {}),
    }),
  },
  {
    id: 'pyright', label: 'Pyright (Python)', languages: ['python'],
    install: { kind: 'npm', package: 'pyright', version: '1.1.405' },
    entryRelPath: 'node_modules/pyright/langserver.index.js', args: ['--stdio'], sizeLabel: '~50 MB',
  },
  {
    id: 'vscode-langservers', label: 'JSON / CSS / HTML (vscode language servers)',
    languages: ['json', 'css', 'scss', 'less', 'html'],
    install: { kind: 'npm', package: 'vscode-langservers-extracted', version: '4.10.0' },
    entryRelPath: 'node_modules/vscode-langservers-extracted/bin', args: ['--stdio'], sizeLabel: '~10 MB',
  },
  {
    id: 'jdtls', label: 'Eclipse JDT LS (Java)', languages: ['java'],
    install: {
      kind: 'binary', version: '1.60.0', binRelPath: JDTLS_LAUNCHER,
      assets: Object.fromEntries(SUPPORTED_LSP_TARGETS.map((target) => [target, {
        url: JDTLS_URL, sha256: JDTLS_SHA256, archive: 'tar.gz' as const,
      }])) as Partial<Record<LspTargetKey, LspBinaryAsset>>,
      companions: [{
        url: JDTLS_LOMBOK_URL, sha256: JDTLS_LOMBOK_SHA256, relPath: JDTLS_LOMBOK_RELPATH,
      }],
    },
    args: [], runtime: { kind: 'java', minMajor: 21 }, spawn: jdtlsSpawnSpec, sizeLabel: '~51 MB',
    initializationOptions: () => ({ settings: { java: jdtJavaSettings() } }),
  },
  {
    id: 'omnisharp', label: 'OmniSharp (C#)', languages: ['csharp'],
    install: {
      kind: 'binary', version: '1.39.15', binRelPath: 'OmniSharp', assets: {
        'linux-arm64': { url: `${OMNISHARP_BASE}/omnisharp-linux-arm64-net6.0.tar.gz`, sha256: 'f98302d820dc60766f8cb37a4bb3da403b69c162c66c2a3c1c2ee63f89dc9b64', archive: 'tar.gz' },
        'linux-x64': { url: `${OMNISHARP_BASE}/omnisharp-linux-x64-net6.0.tar.gz`, sha256: 'e34b2ad29c31202b05dbdc1439600f98ea38acf656f84817c52e3dda81879f6c', archive: 'tar.gz' },
        'darwin-arm64': { url: `${OMNISHARP_BASE}/omnisharp-osx-arm64-net6.0.tar.gz`, sha256: 'ae9ccca3ef1c4a4a3fbae7186a02bbc6c1290d8f4e2c845a214dabaf03cd7103', archive: 'tar.gz' },
        'darwin-x64': { url: `${OMNISHARP_BASE}/omnisharp-osx-x64-net6.0.tar.gz`, sha256: 'bd2d273aff669645bdac2ee382d3a9c0220381b725a78697c9f6b6df9d22dafb', archive: 'tar.gz' },
        'win32-arm64': { url: `${OMNISHARP_BASE}/omnisharp-win-arm64-net6.0.zip`, sha256: 'b8294f77e368a85875767f8e3a82cd4f9c8de2ecc727d71d0dd378a9107c4588', archive: 'zip', binRelPath: 'OmniSharp.exe' },
        'win32-x64': { url: `${OMNISHARP_BASE}/omnisharp-win-x64-net6.0.zip`, sha256: 'b03eb6b9ac6446fce803b87c0965e94cef5570cc86f47bfefe2f60933d8658e8', archive: 'zip', binRelPath: 'OmniSharp.exe' },
      },
    },
    args: [], runtime: { kind: 'dotnet', minMajor: 6 }, spawn: omnisharpSpawnSpec,
    activation: 'interactive', workspaceFolders: false, sizeLabel: '~55 MB',
  },
  {
    id: 'rust-analyzer', label: 'rust-analyzer (Rust)', languages: ['rust'],
    install: {
      kind: 'binary', version: '2025-01-20', binRelPath: 'rust-analyzer', assets: {
        'win32-x64': { url: `${RA_BASE}/rust-analyzer-x86_64-pc-windows-msvc.zip`, sha256: 'b0a100c6631fe80b344c2a07d40e54f110603db301973c1646d6df8fb12bd721', archive: 'zip', binRelPath: 'rust-analyzer.exe' },
        'win32-arm64': { url: `${RA_BASE}/rust-analyzer-aarch64-pc-windows-msvc.zip`, sha256: '93d711b24150835cbb9345e6faf7b24699bb62072c4d7e0755da5572ca11e9d1', archive: 'zip', binRelPath: 'rust-analyzer.exe' },
        'darwin-x64': { url: `${RA_BASE}/rust-analyzer-x86_64-apple-darwin.gz`, sha256: '66d6845a0efdc9fe0f616e90ee6eb935f08eea5eb21abc1d1b632a0053de8f19', archive: 'gz' },
        'darwin-arm64': { url: `${RA_BASE}/rust-analyzer-aarch64-apple-darwin.gz`, sha256: 'a009a531104801259ff6a99f9e7ffcf1e9079c01a1ab77ce353c3cba12d63fcd', archive: 'gz' },
        'linux-x64': { url: `${RA_BASE}/rust-analyzer-x86_64-unknown-linux-gnu.gz`, sha256: 'ca8f88a5799764807c905b234452079119f0be94ba77672f9c347339d22f2b4b', archive: 'gz' },
        'linux-arm64': { url: `${RA_BASE}/rust-analyzer-aarch64-unknown-linux-gnu.gz`, sha256: '75127c950c551327cbc9a57657aa9722fc385cf048985485d480e170866d22c5', archive: 'gz' },
      },
    },
    args: [], sizeLabel: '~16 MB',
  },
  {
    id: 'ruff', label: 'Ruff (Python linter/formatter)', languages: ['python'], role: 'linter',
    install: {
      kind: 'binary', version: '0.11.13', binRelPath: 'ruff', assets: {
        'win32-x64': { url: `${RUFF_BASE}/ruff-x86_64-pc-windows-msvc.zip`, sha256: 'd77fb4ed36392337d334bf9bcef1c5d91ec221e96c53ae8aa147e922c71ddb64', archive: 'zip', binRelPath: 'ruff.exe' },
        'win32-arm64': { url: `${RUFF_BASE}/ruff-aarch64-pc-windows-msvc.zip`, sha256: '67c4e1196d798ab8e4c0fb3fc81e3799ec9fcab1d236f286d348dcd6dfe4cfc2', archive: 'zip', binRelPath: 'ruff.exe' },
        'darwin-x64': { url: `${RUFF_BASE}/ruff-x86_64-apple-darwin.tar.gz`, sha256: '8dcc61306472f75c07af6d0446060e26227d773cee319d21900ac3a1d7bc4955', archive: 'tar.gz', binRelPath: 'ruff-x86_64-apple-darwin/ruff' },
        'darwin-arm64': { url: `${RUFF_BASE}/ruff-aarch64-apple-darwin.tar.gz`, sha256: '7d5e8feea7ee5c3962807996cad557e8a0c4d676c1cba6223bfb0e8b2ca07723', archive: 'tar.gz', binRelPath: 'ruff-aarch64-apple-darwin/ruff' },
        'linux-x64': { url: `${RUFF_BASE}/ruff-x86_64-unknown-linux-gnu.tar.gz`, sha256: '01aa32d29d00876b8d1429c617ed63a00b1fc81abfa4183bb05c9cb647fbc3d0', archive: 'tar.gz', binRelPath: 'ruff-x86_64-unknown-linux-gnu/ruff' },
        'linux-arm64': { url: `${RUFF_BASE}/ruff-aarch64-unknown-linux-gnu.tar.gz`, sha256: '551af2ebc439d8268dcaf871ea60ad035f688728d30943dcbb2bf775e105213e', archive: 'tar.gz', binRelPath: 'ruff-aarch64-unknown-linux-gnu/ruff' },
      },
    },
    args: ['server'], sizeLabel: '~11 MB',
  },
] as const;
