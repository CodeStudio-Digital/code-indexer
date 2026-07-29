use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionBoundary {
    Native,
    HostDelegated,
    DisposableChild,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityDescriptor {
    pub id: String,
    pub version: u32,
    pub execution_boundary: ExecutionBoundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DescriptorError {
    EmptyIdentifier,
    UnspecifiedVersion,
}

impl Display for DescriptorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid capability descriptor: {self:?}")
    }
}

impl Error for DescriptorError {}

impl CapabilityDescriptor {
    /// Validates the stable identity of a capability.
    ///
    /// # Errors
    ///
    /// Returns [`DescriptorError`] for an empty identifier or version zero.
    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.id.trim().is_empty() {
            return Err(DescriptorError::EmptyIdentifier);
        }
        if self.version == 0 {
            return Err(DescriptorError::UnspecifiedVersion);
        }
        Ok(())
    }
}
