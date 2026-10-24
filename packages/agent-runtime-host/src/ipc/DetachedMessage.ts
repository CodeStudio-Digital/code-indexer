import { fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';

/** Own every byte, including Node Buffer inputs whose slice() aliases memory.
 * Lifecycle owners scrub secrets independently; a shared byte view can revoke
 * another owner's receipt while it is still awaiting durable confirmation. */
export function detachedMessage<Desc extends DescMessage>(schema: Desc, value: MessageShape<Desc>): MessageShape<Desc> {
  return fromBinary(schema, toBinary(schema, value));
}
