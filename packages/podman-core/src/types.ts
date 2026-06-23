/**
 * Shared Podman value types. Pure data shapes consumed by both the IDE plugin
 * (extensions/podman, via `ctx.exec.run`) and the company sandbox runtime
 * (packages/services PodmanDriver, via `IShellPort`). No I/O lives here — only
 * the normalized representation of what `podman ... --format json` emits.
 */

/** A container row as surfaced by `podman ps [-a] --format json`. */
export interface ContainerSummary {
  id: string;
  /** Container names (Podman reports an array; first is the primary). */
  names: string[];
  image: string;
  /** Lifecycle state: `running` | `paused` | `exited` | `created` | … */
  state: string;
  /** Human status text, e.g. `Up 2 minutes` / `Exited (0) 1 hour ago`. */
  status: string;
  /** Flattened port mappings, e.g. `0.0.0.0:8080->80/tcp`. */
  ports: string;
  /** Pod id/name when the container belongs to a pod, else empty. */
  pod?: string;
  createdAt?: string;
  labels?: Record<string, string>;
}

/** An image row as surfaced by `podman images --format json`. */
export interface ImageSummary {
  id: string;
  /** Repository without the tag (may be `<none>` for dangling images). */
  repository: string;
  tag: string;
  /** `repository:tag` convenience reference. */
  reference: string;
  /** Size in bytes when the runtime reports it. */
  size?: number;
  createdAt?: string;
}

/** A named volume as surfaced by `podman volume ls --format json`. */
export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint?: string;
}

/** A network as surfaced by `podman network ls --format json`. */
export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
}

/** A pod as surfaced by `podman pod ps --format json`. */
export interface PodSummary {
  id: string;
  name: string;
  status: string;
  containers: number;
}

/**
 * Declarative description of a `podman run`. `runArgs(spec)` turns this into a
 * concrete argv — the single place run flags are assembled so the plugin and
 * the driver stay byte-for-byte consistent.
 */
export interface RunSpec {
  image: string;
  name?: string;
  /** `-d` — run detached. */
  detach?: boolean;
  /** `--rm` — remove on exit. */
  remove?: boolean;
  /** `-p` host:container[/proto] entries. */
  ports?: string[];
  /** `-e KEY=VALUE` environment. */
  env?: Record<string, string>;
  /** `-v` bind/volume mounts, e.g. `/host:/app`. */
  volumes?: string[];
  /** `-w` working directory inside the container. */
  workdir?: string;
  /** `--network` to attach. */
  network?: string;
  /** `--label key=value` metadata. */
  labels?: Record<string, string>;
  /** Trailing command argv (overrides the image CMD). */
  command?: string[];
  /** Raw passthrough flags inserted before the image — caller's responsibility. */
  extraArgs?: string[];
}
