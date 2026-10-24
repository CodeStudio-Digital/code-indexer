import { toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { OwnedAttemptAdapter, type AttemptRuntimeLauncher } from '../facade/OwnedAttemptAdapter.js';
import type { PreparedAgentAttempt } from '../facade/types.js';
import type { RuntimeRouteRecord } from '../router/types.js';
import { attemptIdentityEqual } from '../ipc/FrameHeaderValidation.js';
import { semanticSha256 } from '../ipc/semantic-hash.js';
import { NativeAttemptLease } from './NativeAttemptLease.js';
import type { NativeRustHostAttemptRuntime, NativeRustHostAttemptRuntimeOptions } from './NativeRustHostAttemptRuntime.js';
import { nativePrepareAttempt } from './NativeAttemptProvisioning.js';

export interface NativeAttemptProvisioner {
  assertCurrent: AttemptRuntimeLauncher['assertCurrent'];
  assertCancellationAuthority?: AttemptRuntimeLauncher['assertCancellationAuthority'];
  provision(prepared: PreparedAgentAttempt, route: RuntimeRouteRecord,
    signal: AbortSignal): Promise<NativeRustHostAttemptRuntimeOptions>;
  /** Install the bounded product event consumer before the first provider turn. */
  runtimeCreated?(runtime: NativeRustHostAttemptRuntime): void | Promise<void>;
  leaseAcquired?(lease: NativeAttemptLease): void;
}

/** Physical adapter behind the facade. Provisioning still enforces the existing
 * explicit test/shadow gate; this adapter does not certify a product surface. */
export class NativeRustAgentRuntimeAdapter extends OwnedAttemptAdapter {
  constructor(provisioner: NativeAttemptProvisioner, maximumAttempts?: number) {
    super('rust_v1', {
      assertCurrent: (authority) => provisioner.assertCurrent(authority),
      assertCancellationAuthority: (authority) => provisioner.assertCancellationAuthority
        ? provisioner.assertCancellationAuthority(authority) : provisioner.assertCurrent(authority),
      async launch(prepared, route, signal) {
        if (!('wireSpec' in prepared)) throw new Error('Native runtime requires a resolved native wire spec');
        // Legacy startup must not load the physical bridge. Once routed here,
        // load it before provisioning the short-lived launch authority: cold
        // module loading must not consume that authority's bootstrap margin.
        const { NativeRustHostAttemptRuntime } = await import('./NativeRustHostAttemptRuntime.js');
        signal.throwIfAborted();
        const options = await provisioner.provision(prepared, route, signal);
        signal.throwIfAborted();
        const spec = prepared.wireSpec;
        const encodedSpec = toBinary(agentV1Runtime.ResolvedAttemptSpecSchema, spec);
        const digest = semanticSha256({ schemaId: 'codestudio.agent.v1.ResolvedAttemptSpec',
          schemaVersion: spec.schemaVersion, canonicalBytes: encodedSpec });
        if (!spec.identity || !options.launch.identity || !options.sessionStore
          || !attemptIdentityEqual(options.launch.identity, spec.identity)
          || options.sessionStore.sessionId !== prepared.authority.sessionId
          || options.runtimePackage.manifest.buildId !== route.runtimeBuildId
          || !Buffer.from(digest).equals(prepared.expectedSpecSha256)) {
          throw new Error('native adapter provision differs from the committed attempt');
        }
        const runtime = await NativeRustHostAttemptRuntime.create(options, signal);
        try {
          await provisioner.runtimeCreated?.(runtime);
          const launched = await runtime.run(nativePrepareAttempt(spec), signal);
          if (launched.kind !== 'active') throw new Error('native adapter launch rejected');
          const lease = new NativeAttemptLease(runtime, launched.authority, spec.identity.attemptId, {
            deadlineAtUnixMs: spec.deadlineAtUnixMs,
            cancelGraceMs: options.launch.resourceBudget!.cancelGraceMs,
          }, options.data.clock);
          provisioner.leaseAcquired?.(lease);
          return lease;
        } catch (cause) {
          await runtime.close(cause);
          throw cause;
        }
      },
    }, maximumAttempts);
  }
}
