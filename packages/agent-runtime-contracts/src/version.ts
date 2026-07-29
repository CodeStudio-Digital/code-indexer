export const CONTROL_PLANE_CONTRACT_VERSION = '1.0.0' as const;
export const CONTROL_PLANE_SCHEMA_VERSION = 1 as const;
export const MAX_PROTOCOL_VERSION_COMPONENT = 0xffff;

export type ControlPlaneSchemaVersion = typeof CONTROL_PLANE_SCHEMA_VERSION;

export interface ProtocolVersionComponents {
  major: number;
  minor: number;
}

/** Packs FrameHeader.protocol_version as `(major << 16) | minor`. */
export function packProtocolVersion(
  version: ProtocolVersionComponents,
): number {
  assertProtocolComponent(version.major, 'major');
  assertProtocolComponent(version.minor, 'minor');
  return version.major * 0x1_0000 + version.minor;
}

export function unpackProtocolVersion(
  wireVersion: number,
): ProtocolVersionComponents {
  if (
    !Number.isInteger(wireVersion)
    || wireVersion < 0
    || wireVersion > 0xffff_ffff
  ) {
    throw new RangeError('wireVersion must be a uint32');
  }
  return {
    major: Math.floor(wireVersion / 0x1_0000),
    minor: wireVersion % 0x1_0000,
  };
}

function assertProtocolComponent(value: number, field: string): void {
  if (
    !Number.isInteger(value)
    || value < 0
    || value > MAX_PROTOCOL_VERSION_COMPONENT
  ) {
    throw new RangeError(`${field} must be a uint16`);
  }
}
