use std::fmt::{self, Debug, Formatter};

use super::ProtectedEndpointError;

const MIN_ENDPOINT_NAME_BYTES: usize = 16;
const MAX_ENDPOINT_NAME_BYTES: usize = 64;
const MIN_ENDPOINT_BUFFER_BYTES: u32 = 4 * 1_024;
const MAX_ENDPOINT_BUFFER_BYTES: u32 = 1_024 * 1_024;

/// Canonical lowercase name used to derive a platform-local endpoint.
///
/// Separators, traversal, UNC prefixes and case aliases are unrepresentable.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct EndpointName(String);

impl EndpointName {
    /// Validates one caller-generated, collision-resistant logical name.
    ///
    /// # Errors
    ///
    /// Rejects names outside the bounded lowercase `[a-z0-9-]` grammar.
    pub fn new(value: impl Into<String>) -> Result<Self, ProtectedEndpointError> {
        let value = value.into();
        let bytes = value.as_bytes();
        let bounded = (MIN_ENDPOINT_NAME_BYTES..=MAX_ENDPOINT_NAME_BYTES).contains(&bytes.len());
        let canonical = bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
        let delimited = bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            && bytes.last().is_some_and(u8::is_ascii_alphanumeric);
        if !bounded || !canonical || !delimited {
            return Err(ProtectedEndpointError::InvalidName);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Debug for EndpointName {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("EndpointName([REDACTED])")
    }
}

/// Bounded operating-system buffer request. Protocol frame caps remain
/// independently enforced by `agent-protocol`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndpointBufferCapacity(u32);

impl EndpointBufferCapacity {
    /// # Errors
    ///
    /// Rejects buffers outside the V1 pulse-to-data envelope range.
    pub const fn new(bytes: u32) -> Result<Self, ProtectedEndpointError> {
        if bytes < MIN_ENDPOINT_BUFFER_BYTES || bytes > MAX_ENDPOINT_BUFFER_BYTES {
            return Err(ProtectedEndpointError::InvalidBufferCapacity);
        }
        Ok(Self(bytes))
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Validated native address minted only after a successful bind.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ProtectedEndpointAddress(String);

impl ProtectedEndpointAddress {
    pub(crate) const fn from_bound(value: String) -> Self {
        Self(value)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Debug for ProtectedEndpointAddress {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProtectedEndpointAddress([REDACTED])")
    }
}

/// Process identity expected to own the first accepted local connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpectedLocalPeer {
    process_id: u32,
}

impl ExpectedLocalPeer {
    /// # Errors
    ///
    /// A zero process identifier can never authorize a peer.
    pub const fn new(process_id: u32) -> Result<Self, ProtectedEndpointError> {
        if process_id == 0 {
            return Err(ProtectedEndpointError::InvalidPeer);
        }
        Ok(Self { process_id })
    }

    #[must_use]
    pub const fn process_id(self) -> u32 {
        self.process_id
    }
}

/// Immutable peer evidence attached to a verified stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedLocalPeer {
    process_id: u32,
}

impl VerifiedLocalPeer {
    #[cfg(windows)]
    pub(crate) const fn new(process_id: u32) -> Self {
        Self { process_id }
    }

    #[must_use]
    pub const fn process_id(self) -> u32 {
        self.process_id
    }
}
