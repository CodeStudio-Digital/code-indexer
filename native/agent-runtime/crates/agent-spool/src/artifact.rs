use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactRef {
    pub artifact_id: String,
    pub kind: String,
    pub content_sha256: [u8; 32],
    pub media_type: String,
    pub byte_length: u64,
    pub privacy_class: String,
    pub redaction_policy_version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactError {
    EmptyIdentifier,
    EmptyKind,
    EmptyMediaType,
    EmptyArtifact,
}

impl Display for ArtifactError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid artifact metadata: {self:?}")
    }
}

impl Error for ArtifactError {}

impl ArtifactRef {
    /// Validates the bounded metadata required to address an artifact.
    ///
    /// # Errors
    ///
    /// Returns [`ArtifactError`] when an identifier or content field is empty.
    pub fn validate(&self) -> Result<(), ArtifactError> {
        if self.artifact_id.trim().is_empty() {
            return Err(ArtifactError::EmptyIdentifier);
        }
        if self.kind.trim().is_empty() {
            return Err(ArtifactError::EmptyKind);
        }
        if self.media_type.trim().is_empty() {
            return Err(ArtifactError::EmptyMediaType);
        }
        if self.byte_length == 0 {
            return Err(ArtifactError::EmptyArtifact);
        }
        Ok(())
    }
}
