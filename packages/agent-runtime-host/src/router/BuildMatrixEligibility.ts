import type { RuntimeEligibilityPort } from './ports.js';
import type {
  RuntimeEligibilityDecision,
  RuntimeEligibilityInput,
  RuntimeIneligibilityReason,
  RuntimeIneligibilityReasonCode,
} from './types.js';

export interface RustRuntimeSupportMatrix {
  enabled: boolean;
  build: {
    engineVersion: string;
    runtimeBuildId: string;
    runtimeBinarySha256: string;
    protocolVersion: string;
  };
  containmentLevels: readonly string[];
  surfaces: readonly string[];
  platforms: readonly string[];
  environmentKinds: readonly string[];
  providers: readonly string[];
  capabilityProfiles: readonly string[];
  capabilityCatalogVersions: readonly string[];
  capabilityIds: readonly string[];
}

interface SupportCheck {
  code: RuntimeIneligibilityReasonCode;
  dimension: string;
  requested: string;
  supported: ReadonlySet<string>;
}

function normalizedSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

function unsupportedReason(check: SupportCheck): RuntimeIneligibilityReason | undefined {
  if (check.supported.has(check.requested)) return undefined;
  return {
    code: check.code,
    dimension: check.dimension,
    requested: check.requested,
  };
}

/**
 * Exact-match build eligibility. Every declared dimension must be supported by
 * the same installed Rust build; missing or malformed input is denied.
 */
export class BuildMatrixEligibility implements RuntimeEligibilityPort {
  private readonly matrix: {
    enabled: boolean;
    build: RustRuntimeSupportMatrix['build'];
    containmentLevels: ReadonlySet<string>;
    surfaces: ReadonlySet<string>;
    platforms: ReadonlySet<string>;
    environmentKinds: ReadonlySet<string>;
    providers: ReadonlySet<string>;
    capabilityProfiles: ReadonlySet<string>;
    capabilityCatalogVersions: ReadonlySet<string>;
    capabilityIds: ReadonlySet<string>;
  };

  constructor(matrix: RustRuntimeSupportMatrix) {
    this.matrix = {
      enabled: matrix.enabled,
      build: {
        engineVersion: matrix.build.engineVersion.trim(),
        runtimeBuildId: matrix.build.runtimeBuildId.trim(),
        runtimeBinarySha256: matrix.build.runtimeBinarySha256.trim().toLowerCase(),
        protocolVersion: matrix.build.protocolVersion.trim(),
      },
      containmentLevels: normalizedSet(matrix.containmentLevels),
      surfaces: normalizedSet(matrix.surfaces),
      platforms: normalizedSet(matrix.platforms),
      environmentKinds: normalizedSet(matrix.environmentKinds),
      providers: normalizedSet(matrix.providers),
      capabilityProfiles: normalizedSet(matrix.capabilityProfiles),
      capabilityCatalogVersions: normalizedSet(matrix.capabilityCatalogVersions),
      capabilityIds: normalizedSet(matrix.capabilityIds),
    };
  }

  async evaluate(input: RuntimeEligibilityInput): Promise<RuntimeEligibilityDecision> {
    const reasons: RuntimeIneligibilityReason[] = [];
    if (!this.matrix.enabled) {
      reasons.push({ code: 'rust_disabled', dimension: 'runtime' });
    }

    const requiredStrings = [
      ['surface', input.surface],
      ['platform', input.platform],
      ['environmentKind', input.environmentKind],
      ['provider', input.provider],
      ['capabilityProfile', input.capabilityProfile],
      ['capabilityCatalogVersion', input.capabilityCatalogVersion],
      ['engineVersion', input.engineVersion],
      ['runtimeBuildId', input.runtimeBuildId],
      ['runtimeBinarySha256', input.runtimeBinarySha256],
      ['protocolVersion', input.protocolVersion],
      ['requiredContainmentLevel', input.requiredContainmentLevel],
    ] as const;
    for (const [dimension, value] of requiredStrings) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        reasons.push({
          code: 'invalid_eligibility_input',
          dimension,
          detail: 'A non-empty string is required',
        });
      }
    }

    const checks: SupportCheck[] = [
      {
        code: 'surface_unsupported',
        dimension: 'surface',
        requested: input.surface,
        supported: this.matrix.surfaces,
      },
      {
        code: 'platform_unsupported',
        dimension: 'platform',
        requested: input.platform,
        supported: this.matrix.platforms,
      },
      {
        code: 'environment_unsupported',
        dimension: 'environment',
        requested: input.environmentKind,
        supported: this.matrix.environmentKinds,
      },
      {
        code: 'provider_unsupported',
        dimension: 'provider',
        requested: input.provider,
        supported: this.matrix.providers,
      },
      {
        code: 'capability_profile_unsupported',
        dimension: 'capability_profile',
        requested: input.capabilityProfile,
        supported: this.matrix.capabilityProfiles,
      },
      {
        code: 'capability_catalog_unsupported',
        dimension: 'capability_catalog',
        requested: input.capabilityCatalogVersion,
        supported: this.matrix.capabilityCatalogVersions,
      },
    ];

    for (const check of checks) {
      const reason = unsupportedReason(check);
      if (reason) reasons.push(reason);
    }
    for (const capabilityId of input.capabilityIds) {
      if (typeof capabilityId !== 'string' || capabilityId.trim().length === 0) {
        reasons.push({
          code: 'invalid_eligibility_input',
          dimension: 'capability',
          detail: 'Capability IDs must be non-empty strings',
        });
      } else if (!this.matrix.capabilityIds.has(capabilityId)) {
        reasons.push({
          code: 'capability_unsupported',
          dimension: 'capability',
          requested: capabilityId,
        });
      }
    }

    const exactBuildChecks = [
      {
        matches: input.engineVersion === this.matrix.build.engineVersion,
        code: 'engine_version_unsupported',
        dimension: 'engine_version',
        requested: input.engineVersion,
      },
      {
        matches: input.runtimeBuildId === this.matrix.build.runtimeBuildId,
        code: 'build_id_unsupported',
        dimension: 'runtime_build_id',
        requested: input.runtimeBuildId,
      },
      {
        matches:
          /^[a-f0-9]{64}$/.test(input.runtimeBinarySha256)
          && input.runtimeBinarySha256 === this.matrix.build.runtimeBinarySha256,
        code: 'binary_digest_mismatch',
        dimension: 'runtime_binary_sha256',
        requested: input.runtimeBinarySha256,
      },
      {
        matches: input.protocolVersion === this.matrix.build.protocolVersion,
        code: 'protocol_version_unsupported',
        dimension: 'protocol_version',
        requested: input.protocolVersion,
      },
      {
        matches: this.matrix.containmentLevels.has(input.requiredContainmentLevel),
        code: 'containment_level_unsupported',
        dimension: 'containment_level',
        requested: input.requiredContainmentLevel,
      },
    ] as const;
    for (const check of exactBuildChecks) {
      if (!check.matches) {
        reasons.push({
          code: check.code,
          dimension: check.dimension,
          requested: check.requested,
        });
      }
    }

    return { eligible: reasons.length === 0, reasons };
  }
}
