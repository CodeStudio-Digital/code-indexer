use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::frame::{FrameValidationError, InboundFrameError};
use agent_protocol::generated::v1 as wire;
use agent_protocol::handshake::HandshakeError;
use agent_protocol::semantic_hash::SemanticHashError;
use agent_protocol::wire_identity::WireIdentityError;

use crate::lifecycle::RunnerLifecycleError;

use super::spec_validation::SpecValidationError;

mod display;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextFieldError {
    Empty,
    ContainsNul,
    TooShort { length: usize, minimum: usize },
    TooLong { length: usize, maximum: usize },
}

impl Display for TextFieldError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("value is empty"),
            Self::ContainsNul => formatter.write_str("value contains NUL"),
            Self::TooShort { length, minimum } => {
                write!(formatter, "value has {length} bytes; minimum is {minimum}")
            }
            Self::TooLong { length, maximum } => {
                write!(formatter, "value has {length} bytes; maximum is {maximum}")
            }
        }
    }
}

impl Error for TextFieldError {}

#[derive(Debug)]
pub enum ControlError {
    InvalidRuntimeInstanceId(TextFieldError),
    InvalidAgentHello(&'static str),
    InvalidHostHello(&'static str),
    Handshake(HandshakeError),
    LaunchAuthorityMismatch,
    ConnectionNotEstablished,
    ConnectionContextMismatch,
    UnexpectedInboundMessage(&'static str),
    InboundFrame(InboundFrameError),
    InvalidResolvedSpec(SpecValidationError),
    UnsupportedSpecSchemaVersion(u32),
    InvalidSpecDeadline(i64),
    SpecDeadlineExceedsLaunch {
        spec: i64,
        launch: i64,
    },
    AttemptDeadlineExpired {
        deadline: i64,
        now: i64,
    },
    InvalidEffectiveResourceBudget(&'static str),
    EffectiveResourceBudgetMismatch,
    InvalidEffectiveContainment(&'static str),
    InvalidReadyAtUnixMs(i64),
    HydratedFactsTooLarge {
        length: usize,
        maximum: usize,
    },
    InvalidHydrationToken,
    PrepareNotHydrating,
    RequiredContainmentLevelMissing,
    RequiredContainmentLimitMissing(wire::ResourceLimitKind),
    ContainmentCapabilityMismatch(wire::ResourceLimitKind),
    MissingSpecResourceBudget,
    MissingRequiredSpecSnapshot(&'static str),
    MissingSpecTask,
    MissingSpecTaskBody,
    InvalidSpecField(&'static str),
    InvalidSnapshot {
        collection: &'static str,
        index: usize,
        reason: &'static str,
    },
    SnapshotCoverageMismatch,
    ArtifactCoverageMismatch,
    ArtifactOwnerMismatch {
        index: usize,
    },
    ArtifactBudgetExceeded,
    InvalidValidatedArtifact {
        index: usize,
        reason: &'static str,
    },
    MissingIdentity,
    MissingSpecIdentity,
    InvalidIdentity(WireIdentityError),
    SpecIdentityMismatch,
    ActivationIdentityMismatch,
    EmptyEncodedSpec,
    ZeroSpecSchemaVersion,
    MalformedResolvedSpec,
    SpecSchemaVersionMismatch {
        outer: u32,
        decoded: u32,
    },
    InvalidIdempotencyKey(TextFieldError),
    InvalidTerminationReasonCode(TextFieldError),
    InvalidTerminationReasonCodeCharacters,
    InvalidActivationNonce(TextFieldError),
    InvalidExpectedSpecHashLength(usize),
    InvalidActivationSpecHashLength(usize),
    SpecHashMismatch,
    SemanticHash(SemanticHashError),
    ControlMessageTooLarge {
        length: usize,
        maximum: usize,
    },
    PreparedResponseTooLarge {
        length: usize,
        maximum: usize,
    },
    InvalidOutboundHeader(&'static str),
    FrameEncoding(FrameValidationError),
    PrepareConflict,
    ActivationBeforePrepare,
    ActivationConflict,
    TerminationIdentityMismatch,
    TerminationNotActive,
    TerminationConflict,
    InvalidCancelAttempt(&'static str),
    InvalidFenceAttempt(&'static str),
    ZeroAgentRunVersion,
    ZeroAttemptVersion,
    ActivationAgentRunVersionMismatch {
        expected: u64,
        actual: u64,
    },
    ActivationAttemptVersionMismatch {
        expected: u64,
        actual: u64,
    },
    ActivationNonceMismatch,
    ActivationDeadlineExceedsSpec {
        requested: i64,
        immutable: i64,
    },
    Lifecycle(RunnerLifecycleError),
}

impl Error for ControlError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidRuntimeInstanceId(error)
            | Self::InvalidIdempotencyKey(error)
            | Self::InvalidTerminationReasonCode(error)
            | Self::InvalidActivationNonce(error) => Some(error),
            Self::InvalidIdentity(error) => Some(error),
            Self::SemanticHash(error) => Some(error),
            Self::Handshake(error) => Some(error),
            Self::FrameEncoding(error) => Some(error),
            Self::InboundFrame(error) => Some(error),
            Self::InvalidResolvedSpec(error) => Some(error),
            Self::Lifecycle(error) => Some(error),
            _ => None,
        }
    }
}

impl From<RunnerLifecycleError> for ControlError {
    fn from(value: RunnerLifecycleError) -> Self {
        Self::Lifecycle(value)
    }
}

impl From<SemanticHashError> for ControlError {
    fn from(value: SemanticHashError) -> Self {
        Self::SemanticHash(value)
    }
}

impl From<HandshakeError> for ControlError {
    fn from(value: HandshakeError) -> Self {
        Self::Handshake(value)
    }
}

impl From<FrameValidationError> for ControlError {
    fn from(value: FrameValidationError) -> Self {
        Self::FrameEncoding(value)
    }
}

impl From<InboundFrameError> for ControlError {
    fn from(value: InboundFrameError) -> Self {
        Self::InboundFrame(value)
    }
}

impl From<SpecValidationError> for ControlError {
    fn from(value: SpecValidationError) -> Self {
        Self::InvalidResolvedSpec(value)
    }
}
