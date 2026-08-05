use std::error::Error;
use std::fmt::{self, Display, Formatter};

const MAX_IDENTIFIER_BYTES: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionClass {
    NativeRead,
    NativeMutation,
    NativeProcess,
    HostCapability,
    ControlInteractive,
    NestedCode,
    RemoteEnvironment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityInvocation {
    pub operation_id: String,
    pub provider_operation_id: String,
    pub tool_use_id: String,
    pub capability_id: String,
    pub capability_version: String,
    pub execution_class: ExecutionClass,
    pub mutates: bool,
    pub encoded_json_input: Vec<u8>,
    pub input_sha256: [u8; 32],
    pub capability_set_sha256: [u8; 32],
    pub idempotency_key: String,
    pub deadline_at_unix_ms: i64,
}

impl CapabilityInvocation {
    /// Validates bounded pre-dispatch authority without granting execution.
    ///
    /// # Errors
    ///
    /// Returns a typed error for incomplete identity, input or deadline.
    pub fn validate(&self, maximum_input_bytes: usize) -> Result<(), InvocationValidationError> {
        for value in [
            self.operation_id.as_str(),
            self.provider_operation_id.as_str(),
            self.tool_use_id.as_str(),
            self.capability_id.as_str(),
            self.capability_version.as_str(),
            self.idempotency_key.as_str(),
        ] {
            if value.trim().is_empty() || value.len() > MAX_IDENTIFIER_BYTES || value.contains('\0')
            {
                return Err(InvocationValidationError::InvalidIdentifier);
            }
        }
        if self.encoded_json_input.is_empty() || self.encoded_json_input.len() > maximum_input_bytes
        {
            return Err(InvocationValidationError::InvalidInput);
        }
        if self.deadline_at_unix_ms <= 0 {
            return Err(InvocationValidationError::InvalidDeadline);
        }
        if self.mutates && self.execution_class == ExecutionClass::NativeRead {
            return Err(InvocationValidationError::ContradictoryExecutionClass);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvocationValidationError {
    InvalidIdentifier,
    InvalidInput,
    InvalidDeadline,
    ContradictoryExecutionClass,
}

impl Display for InvocationValidationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid capability invocation: {self:?}")
    }
}

impl Error for InvocationValidationError {}
