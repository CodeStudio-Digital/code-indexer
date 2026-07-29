export const RUNTIME_PACKAGE_SCHEMA_VERSION = 1 as const;
export const RUNTIME_PACKAGE_ANCHOR_SCHEMA_VERSION = 1 as const;

export type RuntimeBinaryRole = 'hostBridge' | 'runner' | 'supervisor';
export type RuntimeOperatingSystem = 'linux' | 'macos' | 'windows';
export type RuntimeArchitecture = 'aarch64' | 'x86_64';

export interface RuntimePackageBinary {
  readonly role: RuntimeBinaryRole;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RuntimePackageManifest {
  readonly schemaVersion: typeof RUNTIME_PACKAGE_SCHEMA_VERSION;
  readonly packageVersion: string;
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly targetTriple: string;
  readonly operatingSystem: RuntimeOperatingSystem;
  readonly architecture: RuntimeArchitecture;
  readonly contractVersion: string;
  readonly contractSchemaVersion: number;
  readonly binaries: readonly RuntimePackageBinary[];
}

export interface RuntimePackageManifestInput {
  readonly packageVersion: string;
  readonly sourceCommit: string;
  readonly targetTriple: string;
  readonly operatingSystem: RuntimeOperatingSystem;
  readonly architecture: RuntimeArchitecture;
  readonly contractVersion: string;
  readonly contractSchemaVersion: number;
  readonly binaries: readonly RuntimePackageBinary[];
}

export interface RuntimePackageAnchor {
  readonly schemaVersion: typeof RUNTIME_PACKAGE_ANCHOR_SCHEMA_VERSION;
  readonly targetTriple: string;
  readonly buildId: string;
  readonly manifestSha256: string;
}

export interface VerifiedRuntimeBinary extends RuntimePackageBinary {
  readonly absolutePath: string;
}

export interface VerifiedRuntimePackage {
  readonly manifest: RuntimePackageManifest;
  readonly manifestSha256: Uint8Array;
  readonly binaries: Readonly<Record<RuntimeBinaryRole, VerifiedRuntimeBinary>>;
}
