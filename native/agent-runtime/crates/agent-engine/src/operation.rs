use std::error::Error;
use std::fmt::{self, Display, Formatter};

const MAX_OPERATION_ID_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OperationId(String);

impl OperationId {
    /// Creates a bounded, non-empty operation identifier.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidOperationId`] for empty, oversized or NUL-containing
    /// values.
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidOperationId> {
        let value = value.into();
        if value.trim().is_empty() || value.len() > MAX_OPERATION_ID_BYTES || value.contains('\0') {
            return Err(InvalidOperationId);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidOperationId;

impl Display for InvalidOperationId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("operation ID is empty or exceeds its byte limit")
    }
}

impl Error for InvalidOperationId {}
