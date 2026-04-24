/**
 * Public surface of the sandbox runtime.
 *
 * Consumers (SandboxService, http-api preview route, tests) should import
 * only from this barrel to keep the module boundary stable.
 */

export type {
  Sandbox,
  SandboxEvent,
  SandboxObserver,
  SandboxStack,
  SandboxStatus,
  SandboxLimits,
} from './types.js';
export { DEFAULT_SANDBOX_LIMITS } from './types.js';

export type {
  ISandboxDriver,
  SandboxCreateSpec,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxReaddirEntry,
} from './ports/sandbox-driver.js';

export {
  SandboxManager,
  getSandboxManager,
  setSandboxManagerForTests,
  cleanupSessionPersistence,
} from './sandbox-manager.js';
export type { SandboxManagerOptions, ProvisionRequest } from './sandbox-manager.js';

export { PortAllocator } from './port-allocator.js';
export type { PortAllocatorOptions } from './port-allocator.js';

export {
  NetworkController,
  getNetworkController,
  setNetworkControllerForTests,
} from './network-controller.js';
export type { NetworkInfo, NetworkControllerOptions } from './network-controller.js';

export { resolveDriver, setDriverForTests } from './drivers/driver-factory.js';
export type { SandboxRuntimeChoice, ResolveDriverOptions } from './drivers/driver-factory.js';

export { DockerDriver } from './drivers/docker-driver.js';
export { PodmanDriver } from './drivers/podman-driver.js';
export { E2BDriver } from './drivers/e2b-driver.js';
export { CliOciDriver } from './drivers/cli-oci-driver.js';

export { getScaffolder, registerScaffolder } from './scaffolders/registry.js';
export type { IScaffolder, ScaffoldContext } from './scaffolders/scaffolder-port.js';

export { SandboxFilesystemAdapter } from './adapters/sandbox-filesystem-adapter.js';
export { SandboxShellAdapter } from './adapters/sandbox-shell-adapter.js';

export {
  archivePath,
  loadArchive,
  saveArchive,
  deleteArchive,
} from './archive.js';
