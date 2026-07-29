use std::error::Error;
use std::fmt::{self, Display, Formatter};

use sha2::{Digest, Sha256};

const DOMAIN: &[u8] = b"codestudio.agent.semantic-sha256.v1\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticHashError {
    EmptySchemaId,
    SchemaIdTooLong,
    ZeroSchemaVersion,
    CanonicalBytesTooLong,
}

impl Display for SemanticHashError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptySchemaId => formatter.write_str("semantic hash schema ID is empty"),
            Self::SchemaIdTooLong => formatter.write_str("semantic hash schema ID exceeds uint32"),
            Self::ZeroSchemaVersion => {
                formatter.write_str("semantic hash schema version cannot be zero")
            }
            Self::CanonicalBytesTooLong => {
                formatter.write_str("semantic hash canonical bytes exceed uint64")
            }
        }
    }
}

impl Error for SemanticHashError {}

/// Hashes canonical bytes with a schema-qualified, length-delimited preimage.
///
/// # Errors
///
/// Rejects an empty/oversized schema ID or schema version zero.
pub fn semantic_sha256(
    schema_id: &str,
    schema_version: u32,
    canonical_bytes: &[u8],
) -> Result<[u8; 32], SemanticHashError> {
    if schema_id.is_empty() {
        return Err(SemanticHashError::EmptySchemaId);
    }
    let schema_id_length =
        u32::try_from(schema_id.len()).map_err(|_| SemanticHashError::SchemaIdTooLong)?;
    if schema_version == 0 {
        return Err(SemanticHashError::ZeroSchemaVersion);
    }

    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(schema_id_length.to_be_bytes());
    hasher.update(schema_id.as_bytes());
    hasher.update(schema_version.to_be_bytes());
    let canonical_length = u64::try_from(canonical_bytes.len())
        .map_err(|_| SemanticHashError::CanonicalBytesTooLong)?;
    hasher.update(canonical_length.to_be_bytes());
    hasher.update(canonical_bytes);
    Ok(hasher.finalize().into())
}

#[cfg(test)]
mod tests;
