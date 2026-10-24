import { clone } from '@bufbuild/protobuf';
import { agentV1Common } from '@mcp/agent-runtime-contracts';
import type {
  ActiveAttemptAuthorityFacts,
  ActiveAttemptAuthoritySnapshot,
  PreparedDurabilityFacts,
} from './HostLifecycleTypes.js';
import { clonePreparedDurabilityFacts } from './HostLifecycleFacts.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import { scrubPreparedDurabilityFacts } from './PreparedFactsScrub.js';

declare const PREPARED_RECEIPT_BRAND: unique symbol;
declare const ACTIVE_RECEIPT_BRAND: unique symbol;
declare const ACTIVE_AUTHORITY_BRAND: unique symbol;

export interface PreparedAttemptReceipt {
  readonly [PREPARED_RECEIPT_BRAND]: never;
}
export interface ActiveAttemptReceipt {
  readonly [ACTIVE_RECEIPT_BRAND]: never;
}
export interface ActiveAttemptAuthorityHandle {
  readonly [ACTIVE_AUTHORITY_BRAND]: never;
}

class PreparedReceiptValue implements PreparedAttemptReceipt {
  declare readonly [PREPARED_RECEIPT_BRAND]: never;
}
class ActiveReceiptValue implements ActiveAttemptReceipt {
  declare readonly [ACTIVE_RECEIPT_BRAND]: never;
}
class ActiveAuthorityValue implements ActiveAttemptAuthorityHandle {
  declare readonly [ACTIVE_AUTHORITY_BRAND]: never;
}

interface PreparedState {
  readonly binding: object;
  readonly facts: PreparedDurabilityFacts;
}
interface ActiveState {
  readonly binding: object;
  readonly authority: ActiveAttemptAuthorityFacts;
  readonly signal: AbortSignal;
}

const preparedAuthentic = new WeakSet<object>();
const preparedStates = new WeakMap<object, PreparedState>();
const activeReceiptAuthentic = new WeakSet<object>();
const activeReceiptStates = new WeakMap<object, {
  binding: object;
  handle: ActiveAttemptAuthorityHandle;
}>();
const activeHandleAuthentic = new WeakSet<object>();
const activeStates = new WeakMap<object, ActiveState>();

export function mintPreparedAttemptReceipt(
  binding: object,
  facts: PreparedDurabilityFacts,
): PreparedAttemptReceipt {
  const receipt = Object.freeze(new PreparedReceiptValue());
  preparedAuthentic.add(receipt);
  preparedStates.set(receipt, {
    binding,
    facts: clonePreparedDurabilityFacts(facts),
  });
  return receipt;
}

export function consumePreparedAttemptReceipt(
  receipt: PreparedAttemptReceipt,
  binding: object,
): PreparedDurabilityFacts {
  if (!preparedAuthentic.has(receipt)) throw invalid('prepared receipt is forged');
  const state = preparedStates.get(receipt);
  if (!state) throw invalid('prepared receipt is stale');
  if (state.binding !== binding) throw invalid('prepared receipt was transplanted');
  preparedStates.delete(receipt);
  return state.facts;
}

export function revokePreparedAttemptReceipt(
  receipt: PreparedAttemptReceipt,
  binding: object,
): void {
  const state = preparedStates.get(receipt);
  if (!state || state.binding !== binding) return;
  preparedStates.delete(receipt);
  scrubPreparedDurabilityFacts(state.facts);
}

/** Internal test seam; unavailable through the package export map. */
export function inspectPreparedAttemptReceiptForTesting(
  receipt: PreparedAttemptReceipt,
): PreparedDurabilityFacts | undefined {
  return preparedStates.get(receipt)?.facts;
}

export function installActiveAttemptAuthority(
  binding: object,
  authority: ActiveAttemptAuthorityFacts,
  signal: AbortSignal,
): ActiveAttemptReceipt {
  if (signal.aborted) throw revoked();
  const handle = Object.freeze(new ActiveAuthorityValue());
  const receipt = Object.freeze(new ActiveReceiptValue());
  activeHandleAuthentic.add(handle);
  activeStates.set(handle, {
    binding,
    authority: cloneActiveFacts(authority),
    signal,
  });
  activeReceiptAuthentic.add(receipt);
  activeReceiptStates.set(receipt, { binding, handle });
  signal.addEventListener(
    'abort',
    () => {
      activeStates.delete(handle);
      activeReceiptStates.delete(receipt);
    },
    { once: true },
  );
  return receipt;
}

export function consumeActiveAttemptReceipt(
  receipt: ActiveAttemptReceipt,
  binding: object,
): ActiveAttemptAuthorityHandle {
  if (!activeReceiptAuthentic.has(receipt)) throw invalid('active receipt is forged');
  const state = activeReceiptStates.get(receipt);
  if (!state) throw invalid('active receipt is stale');
  if (state.binding !== binding) throw invalid('active receipt was transplanted');
  if (!activeStates.has(state.handle)) throw revoked();
  activeReceiptStates.delete(receipt);
  return state.handle;
}

export function inspectActiveAttemptAuthority(
  handle: ActiveAttemptAuthorityHandle,
  binding: object,
): ActiveAttemptAuthoritySnapshot {
  if (!activeHandleAuthentic.has(handle)) throw invalid('active handle is forged');
  const state = activeStates.get(handle);
  if (!state || state.signal.aborted) throw revoked();
  if (state.binding !== binding) throw invalid('active handle was transplanted');
  return Object.freeze({
    ...cloneActiveFacts(state.authority),
    signal: state.signal,
  });
}

function cloneActiveFacts(
  value: ActiveAttemptAuthorityFacts,
): ActiveAttemptAuthorityFacts {
  return Object.freeze({
    ...value,
    identity: clone(agentV1Common.AttemptIdentitySchema, value.identity),
    specSha256: Uint8Array.from(value.specSha256),
    activationNonce: Uint8Array.from(value.activationNonce),
  });
}

function invalid(message: string): HostLifecycleDriverError {
  return new HostLifecycleDriverError('invalid_receipt', message);
}

function revoked(): HostLifecycleDriverError {
  return new HostLifecycleDriverError(
    'active_authority_revoked',
    'active attempt authority is revoked or expired',
  );
}
