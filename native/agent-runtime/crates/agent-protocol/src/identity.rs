use std::error::Error;
use std::fmt::{self, Display, Formatter};

/// Returned when an opaque protocol identifier has no usable value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyIdentifier;

impl Display for EmptyIdentifier {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("protocol identifiers cannot be empty")
    }
}

impl Error for EmptyIdentifier {}

/// Returned when an operational protocol identifier is not a canonical UUID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidUuidIdentifier {
    Empty,
    NonCanonical,
}

impl Display for InvalidUuidIdentifier {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("protocol identifiers cannot be empty"),
            Self::NonCanonical => {
                formatter.write_str("protocol identifier must be a canonical lowercase UUID")
            }
        }
    }
}

impl Error for InvalidUuidIdentifier {}

pub(crate) fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }

    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
    })
}

macro_rules! opaque_identifier {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            /// Creates an opaque identifier without normalizing its value.
            ///
            /// # Errors
            ///
            /// Returns [`EmptyIdentifier`] when `value` is empty or whitespace only.
            pub fn new(value: impl Into<String>) -> Result<Self, EmptyIdentifier> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(EmptyIdentifier);
                }
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Display for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = EmptyIdentifier;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl TryFrom<String> for $name {
            type Error = EmptyIdentifier;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }
    };
}

macro_rules! uuid_identifier {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            /// Creates an operational identifier from a canonical lowercase UUID.
            ///
            /// # Errors
            ///
            /// Returns [`InvalidUuidIdentifier`] when `value` is empty or is not
            /// represented as a canonical lowercase UUID.
            pub fn new(value: impl Into<String>) -> Result<Self, InvalidUuidIdentifier> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(InvalidUuidIdentifier::Empty);
                }
                if !is_canonical_uuid(&value) {
                    return Err(InvalidUuidIdentifier::NonCanonical);
                }
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Display for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = InvalidUuidIdentifier;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl TryFrom<String> for $name {
            type Error = InvalidUuidIdentifier;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }
    };
}

uuid_identifier!(AgentRunId);
uuid_identifier!(AttemptId);
uuid_identifier!(CommandId);
opaque_identifier!(ConnectionId);
uuid_identifier!(CorrelationId);
opaque_identifier!(ExecutorOwnerId);
opaque_identifier!(MessageId);
opaque_identifier!(OperationId);
opaque_identifier!(RuntimeInstanceId);
uuid_identifier!(SessionId);

/// Durable identity of one physical execution attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptIdentity {
    pub session_id: SessionId,
    pub command_id: CommandId,
    pub agent_run_id: AgentRunId,
    pub attempt_id: AttemptId,
    pub executor_owner_id: ExecutorOwnerId,
    pub fencing_epoch: u64,
    pub correlation_id: CorrelationId,
    pub root_agent_run_id: AgentRunId,
    pub owner_agent_run_id: Option<AgentRunId>,
    pub parent_agent_run_id: Option<AgentRunId>,
}

/// Identity required by a message that may create state or an effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationIdentity {
    pub attempt: AttemptIdentity,
    pub operation_id: OperationId,
    pub correlation_id: CorrelationId,
}

#[cfg(test)]
mod tests {
    use super::{AttemptId, OperationId};

    #[test]
    fn operational_identifiers_require_canonical_lowercase_uuids() {
        let identifier =
            AttemptId::new("00000000-0000-4000-8000-000000000004").expect("valid canonical UUID");

        assert_eq!(identifier.as_str(), "00000000-0000-4000-8000-000000000004");
        assert!(AttemptId::new("attempt:tenant/run#7").is_err());
        assert!(AttemptId::new("00000000-0000-4000-8000-00000000000A").is_err());
    }

    #[test]
    fn transport_identifiers_remain_opaque() {
        let identifier =
            OperationId::new("operation:tenant/run#7").expect("valid opaque identifier");

        assert_eq!(identifier.as_str(), "operation:tenant/run#7");
    }

    #[test]
    fn whitespace_only_identifier_is_rejected() {
        assert!(AttemptId::new(" \t ").is_err());
    }
}
