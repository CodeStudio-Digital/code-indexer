use std::fmt::{self, Debug, Formatter};

use crate::generated::v1 as wire;

use super::compatibility::provenance_matches;
use super::secret::SecretDigest;

#[derive(Clone, PartialEq, Eq)]
pub struct ManagementSessionPolicy {
    contract_version: String,
    contract_schema_version: u32,
    expected_supervisor_provenance: wire::ExpectedRuntimeProvenance,
    allowed_runner_provenance: Vec<wire::ExpectedRuntimeProvenance>,
    limits: wire::SupervisorLimits,
    frame_limits: wire::FrameLimits,
    token_digest: SecretDigest,
    required_containment_level: wire::ContainmentLevel,
    allowed_feature_bits: u64,
}

impl Debug for ManagementSessionPolicy {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("ManagementSessionPolicy")
            .field("contract_version", &self.contract_version)
            .field("contract_schema_version", &self.contract_schema_version)
            .field(
                "expected_supervisor_provenance",
                &self.expected_supervisor_provenance,
            )
            .field(
                "allowed_runner_provenance_count",
                &self.allowed_runner_provenance.len(),
            )
            .field("limits", &self.limits)
            .field("frame_limits", &self.frame_limits)
            .field("token_digest", &"[REDACTED]")
            .field(
                "required_containment_level",
                &self.required_containment_level,
            )
            .field("allowed_feature_bits", &self.allowed_feature_bits)
            .finish()
    }
}

impl ManagementSessionPolicy {
    pub(super) fn new(
        hello: &wire::HostSupervisorHello,
        token_digest: SecretDigest,
        required_containment_level: wire::ContainmentLevel,
    ) -> Self {
        Self {
            contract_version: hello.contract_version.clone(),
            contract_schema_version: hello.contract_schema_version,
            expected_supervisor_provenance: hello
                .expected_supervisor_provenance
                .clone()
                .expect("validated expected supervisor provenance"),
            allowed_runner_provenance: hello.allowed_runner_provenance.clone(),
            limits: hello.limits.expect("validated supervisor limits"),
            frame_limits: hello.frame_limits.expect("validated frame limits"),
            token_digest,
            required_containment_level,
            allowed_feature_bits: hello.allowed_feature_bits,
        }
    }

    #[must_use]
    pub fn contract_version(&self) -> &str {
        &self.contract_version
    }

    #[must_use]
    pub const fn contract_schema_version(&self) -> u32 {
        self.contract_schema_version
    }

    #[must_use]
    pub const fn expected_supervisor_provenance(&self) -> &wire::ExpectedRuntimeProvenance {
        &self.expected_supervisor_provenance
    }

    #[must_use]
    pub fn allowed_runner_provenance(&self) -> &[wire::ExpectedRuntimeProvenance] {
        &self.allowed_runner_provenance
    }

    #[must_use]
    pub const fn limits(&self) -> &wire::SupervisorLimits {
        &self.limits
    }

    #[must_use]
    pub const fn frame_limits(&self) -> &wire::FrameLimits {
        &self.frame_limits
    }

    #[must_use]
    pub const fn required_containment_level(&self) -> wire::ContainmentLevel {
        self.required_containment_level
    }

    #[must_use]
    pub const fn allowed_feature_bits(&self) -> u64 {
        self.allowed_feature_bits
    }

    /// Feature authority selected by the host and proven supported by the
    /// supervisor during bootstrap.
    #[must_use]
    pub const fn effective_feature_bits(&self) -> u64 {
        self.allowed_feature_bits
    }

    #[must_use]
    pub fn authenticates_management_session_token(&self, candidate: &[u8]) -> bool {
        self.token_digest.matches_token(candidate)
    }

    #[must_use]
    pub fn permits_runner_provenance(&self, candidate: &wire::RuntimeProvenance) -> bool {
        self.allowed_runner_provenance
            .iter()
            .any(|allowed| provenance_matches(allowed, candidate))
    }

    #[must_use]
    pub fn permits_expected_runner_provenance(
        &self,
        candidate: &wire::ExpectedRuntimeProvenance,
    ) -> bool {
        self.allowed_runner_provenance
            .iter()
            .any(|allowed| allowed == candidate)
    }
}
