use std::error::Error;
use std::fmt::{self, Display, Formatter};

/// A protocol version negotiated before attempt preparation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl ProtocolVersion {
    #[must_use]
    pub const fn new(major: u16, minor: u16) -> Self {
        Self { major, minor }
    }

    /// Packs the protocol as `(major << 16) | minor` for `FrameHeader`.
    #[must_use]
    pub const fn to_wire(self) -> u32 {
        (self.major as u32) << 16 | self.minor as u32
    }

    #[must_use]
    pub const fn from_wire(value: u32) -> Self {
        let bytes = value.to_be_bytes();
        Self {
            major: u16::from_be_bytes([bytes[0], bytes[1]]),
            minor: u16::from_be_bytes([bytes[2], bytes[3]]),
        }
    }
}

/// Inclusive range of protocol versions supported by one peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolRange {
    pub min: ProtocolVersion,
    pub max: ProtocolVersion,
}

impl ProtocolRange {
    /// Creates an inclusive protocol range.
    ///
    /// # Errors
    ///
    /// Returns [`CompatibilityError::InvalidVersionRange`] when `min` is newer
    /// than `max`.
    pub fn new(min: ProtocolVersion, max: ProtocolVersion) -> Result<Self, CompatibilityError> {
        if min > max {
            return Err(CompatibilityError::InvalidVersionRange);
        }
        Ok(Self { min, max })
    }
}

/// Compact feature bitmap. Unknown optional bits are safely ignored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FeatureSet(u64);

impl FeatureSet {
    pub const NONE: Self = Self(0);

    #[must_use]
    pub const fn from_bits(bits: u64) -> Self {
        Self(bits)
    }

    #[must_use]
    pub const fn bits(self) -> u64 {
        self.0
    }

    #[must_use]
    pub const fn intersection(self, other: Self) -> Self {
        Self(self.0 & other.0)
    }

    #[must_use]
    pub const fn missing_from(self, available: Self) -> Self {
        Self(self.0 & !available.0)
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

/// Compatibility data sent by the runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCompatibility {
    pub versions: ProtocolRange,
    pub supported_features: FeatureSet,
    pub required_features: FeatureSet,
    pub build_id: String,
}

/// Compatibility and revocation policy owned by the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCompatibility {
    pub versions: ProtocolRange,
    pub supported_features: FeatureSet,
    pub required_features: FeatureSet,
    pub revoked_build_ids: Vec<String>,
}

/// Result persisted for the connection after a successful handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NegotiatedProtocol {
    pub version: ProtocolVersion,
    pub features: FeatureSet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompatibilityError {
    InvalidVersionRange,
    IncompatibleVersion,
    MalformedAgentFeatures { missing: FeatureSet },
    MalformedHostFeatures { missing: FeatureSet },
    AgentMissingRequiredFeatures { missing: FeatureSet },
    HostMissingRequiredFeatures { missing: FeatureSet },
    RevokedBuild,
}

impl Display for CompatibilityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVersionRange => formatter.write_str("protocol range is inverted"),
            Self::IncompatibleVersion => formatter.write_str("protocol ranges do not overlap"),
            Self::MalformedAgentFeatures { .. } => {
                formatter.write_str("agent requires features it does not support")
            }
            Self::MalformedHostFeatures { .. } => {
                formatter.write_str("host requires features it does not support")
            }
            Self::AgentMissingRequiredFeatures { .. } => {
                formatter.write_str("agent does not support host-required features")
            }
            Self::HostMissingRequiredFeatures { .. } => {
                formatter.write_str("host does not support agent-required features")
            }
            Self::RevokedBuild => formatter.write_str("agent build is revoked"),
        }
    }
}

impl Error for CompatibilityError {}

/// Selects the newest protocol version and feature set accepted by both peers.
///
/// # Errors
///
/// Returns [`CompatibilityError`] when ranges do not overlap, a required feature
/// is unavailable, either feature declaration is malformed, or the build is revoked.
pub fn negotiate(
    agent: &AgentCompatibility,
    host: &HostCompatibility,
) -> Result<NegotiatedProtocol, CompatibilityError> {
    let malformed_agent = agent
        .required_features
        .missing_from(agent.supported_features);
    if !malformed_agent.is_empty() {
        return Err(CompatibilityError::MalformedAgentFeatures {
            missing: malformed_agent,
        });
    }

    let malformed_host = host.required_features.missing_from(host.supported_features);
    if !malformed_host.is_empty() {
        return Err(CompatibilityError::MalformedHostFeatures {
            missing: malformed_host,
        });
    }

    if host
        .revoked_build_ids
        .iter()
        .any(|revoked| revoked == &agent.build_id)
    {
        return Err(CompatibilityError::RevokedBuild);
    }

    let lower = agent.versions.min.max(host.versions.min);
    let upper = agent.versions.max.min(host.versions.max);
    if lower > upper {
        return Err(CompatibilityError::IncompatibleVersion);
    }

    let agent_missing = host
        .required_features
        .missing_from(agent.supported_features);
    if !agent_missing.is_empty() {
        return Err(CompatibilityError::AgentMissingRequiredFeatures {
            missing: agent_missing,
        });
    }

    let host_missing = agent
        .required_features
        .missing_from(host.supported_features);
    if !host_missing.is_empty() {
        return Err(CompatibilityError::HostMissingRequiredFeatures {
            missing: host_missing,
        });
    }

    Ok(NegotiatedProtocol {
        version: upper,
        features: agent
            .supported_features
            .intersection(host.supported_features),
    })
}

#[cfg(test)]
mod tests;
