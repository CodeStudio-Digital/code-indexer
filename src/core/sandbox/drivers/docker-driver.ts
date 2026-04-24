/**
 * Docker driver — thinnest possible wrapper over `CliOciDriver`.
 *
 * Docker doesn't need any special argv by default. `DOCKER_HOST` in the
 * process env is respected by the CLI itself, so remote daemons (including
 * Docker Desktop over named pipes on Windows) work transparently.
 */

import { defaultLocalShellPort } from '../../coder/ports/shell-port.js';
import type { IShellPort } from '../../coder/ports/shell-port.js';
import { CliOciDriver } from './cli-oci-driver.js';

export interface DockerDriverOptions {
  /** Path to the docker binary. Defaults to `docker` (resolved via PATH). */
  binary?: string;
  /** Shell port used to spawn the CLI. Defaults to the local adapter. */
  shell?: IShellPort;
}

export class DockerDriver extends CliOciDriver {
  constructor(options: DockerDriverOptions = {}) {
    super({
      runtime: 'docker',
      binary: options.binary ?? 'docker',
      shell: options.shell ?? defaultLocalShellPort(),
    });
  }
}
