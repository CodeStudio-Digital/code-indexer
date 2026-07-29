use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::activation_authority::ActivationAuthoritySealError;
use agent_protocol::generated::v1 as wire;
use agent_protocol::semantic_hash::SemanticHashError;
use agent_protocol::wire_identity::WireIdentityError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchContextError {
    InvalidHandoff(&'static str),
    InvalidIdentity(WireIdentityError),
    ZeroFencingEpoch,
    InvalidRuntimeInstanceId,
    InvalidExpectedConnectionId,
    InvalidConnectionSessionToken,
    InvalidActivationAuthoritySeal(ActivationAuthoritySealError),
    EndpointAuthorityMismatch,
    InvalidHardDeadline(i64),
    InvalidResourceBudget(&'static str),
    InvalidContainmentLevel,
    EmptyRequiredLimits,
    InvalidRequiredLimit,
    DuplicateRequiredLimit(wire::ResourceLimitKind),
    InvalidLaunchNonce,
    SemanticHash(SemanticHashError),
}

impl Display for LaunchContextError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHandoff(field) => {
                write!(formatter, "runner handoff field {field} is invalid")
            }
            Self::InvalidIdentity(error) => write!(formatter, "invalid launch identity: {error}"),
            Self::ZeroFencingEpoch => formatter.write_str("launch fencing epoch must be positive"),
            Self::InvalidRuntimeInstanceId => {
                formatter.write_str("launch runtime instance ID is invalid")
            }
            Self::InvalidExpectedConnectionId => {
                formatter.write_str("launch expected connection ID is invalid")
            }
            Self::InvalidConnectionSessionToken => {
                formatter.write_str("launch connection session token is invalid")
            }
            Self::InvalidActivationAuthoritySeal(error) => {
                write!(
                    formatter,
                    "invalid launch activation authority seal: {error}"
                )
            }
            Self::EndpointAuthorityMismatch => {
                formatter.write_str("endpoint token authority differs from control endpoint")
            }
            Self::InvalidHardDeadline(value) => {
                write!(formatter, "launch hard deadline {value} must be positive")
            }
            Self::InvalidResourceBudget(reason) => {
                write!(formatter, "invalid launch resource budget: {reason}")
            }
            Self::InvalidContainmentLevel => {
                formatter.write_str("launch containment level is not enforceable")
            }
            Self::EmptyRequiredLimits => formatter.write_str("launch required limit set is empty"),
            Self::InvalidRequiredLimit => {
                formatter.write_str("launch required limit cannot be unspecified")
            }
            Self::DuplicateRequiredLimit(limit) => {
                write!(formatter, "launch required limit {limit:?} is duplicated")
            }
            Self::InvalidLaunchNonce => formatter.write_str("launch nonce is invalid"),
            Self::SemanticHash(error) => write!(formatter, "cannot hash launch secret: {error}"),
        }
    }
}

impl Error for LaunchContextError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidIdentity(error) => Some(error),
            Self::InvalidActivationAuthoritySeal(error) => Some(error),
            Self::SemanticHash(error) => Some(error),
            _ => None,
        }
    }
}
